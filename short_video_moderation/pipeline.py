"""Prepare once, evaluate with Jev and/or the existing multimodal API family."""
from __future__ import annotations

import argparse
from importlib.resources import files
import asyncio
import hashlib
import json
import os
import time
from dataclasses import asdict, replace
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .providers import ProviderConfig, evaluate
from .sampling import SamplingConfig, prepare_video
from .alignment import align_evidence
from .media import FFmpegTools, _SUBPROCESS_KWARGS
import subprocess
from .transcription import TranscriptionConfig, transcribe_video_blocks


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def prepare(video, destination, sampling, transcription=None, *, asr_key=None, ffmpeg_path=None, ffprobe_path=None, progress=lambda _: None):
    sampling.validate()
    tools = FFmpegTools(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path)
    duration = tools.probe(Path(video)).duration_sec
    if duration > sampling.max_duration_sec:
        raise ValueError('Video exceeds configured short-video duration limit')
    probe = subprocess.run([tools.ffprobe, '-v', 'error', '-select_streams', 'a', '-show_entries',
                            'stream=index', '-of', 'json', str(video)], capture_output=True, check=True,
                           timeout=30, **_SUBPROCESS_KWARGS)
    has_audio = bool(json.loads(probe.stdout)['streams'])
    if has_audio and callable(transcription):
        transcription = transcription()
    if has_audio and transcription is None:
        raise ValueError('Video has audio: provide an ASR configuration')
    if has_audio:
        transcription = replace(transcription, ffmpeg_path=ffmpeg_path or transcription.ffmpeg_path)
        transcription.validate()
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if (destination / 'frames').exists():
        raise ValueError('Use a new preparation directory; existing inputs are immutable')

    def transcribe_audio():
        if not has_audio:
            return []
        audio_dir = destination / 'audio'
        audio_dir.mkdir(exist_ok=True)
        # Cloud requests follow audio-only blocks, independent of visual changes.
        blocks = []
        start = 0.0
        while start < duration:
            end = min(duration, start + 30.0)
            blocks.append(dict(segment_id=len(blocks) + 1, start_sec=start, end_sec=end))
            start = end
        audio_manifest = audio_dir / 'intervals.json'
        write_json(audio_manifest, {'video_id': Path(video).stem, 'segments': blocks})
        transcript = transcribe_video_blocks(video, audio_manifest, config=transcription,
                                           output_dir=audio_dir, api_key=asr_key)
        return [u for segment in transcript['segments'] for u in segment.get('utterances', [])]

    progress('并行处理：画面抽样与音轨转写')
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix='moderation-prepare') as pool:
        audio_future = pool.submit(transcribe_audio)
        visual_future = pool.submit(prepare_video, video, destination, sampling,
                                    ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path)
        manifest, utterances = visual_future.result(), audio_future.result()
    progress('按讲话时间组合画面；补齐静音区间')
    frames = [frame for segment in manifest['segments'] for frame in segment['frames']]
    precision = 'absent' if not has_audio else 'audio_chunk' if transcription.engine == 'mimo-cloud' else 'asr_segment'
    manifest['segments'] = align_evidence(frames, utterances, duration, max_seconds=sampling.segment_sec,
                                       max_frames=sampling.max_frames_per_segment,
                                       audio_status='transcribed' if has_audio else 'absent', precision=precision)
    manifest['alignment'] = {'strategy': 'speech_first_with_silent_windows', 'max_seconds': sampling.segment_sec, 'precision': precision}
    manifest['transcription_config'] = transcription.to_dict() if has_audio else None
    for segment in manifest['segments']:
        segment['input_hash'] = fingerprint(segment)
    manifest['input_hash'] = fingerprint(manifest)
    write_json(Path(destination) / 'inputs.json', manifest)
    return manifest


def validate_policy(policy):
    if not policy.get('version') or not policy.get('categories'):
        raise ValueError('Policy requires version and categories')
    low, high = policy['review_threshold'], policy['block_threshold']
    if not 0 <= low < high <= 1:
        raise ValueError('Require 0 <= review_threshold < block_threshold <= 1')
    for rule in policy['categories'].values():
        if not all(isinstance(rule.get(k), str) and rule[k].strip() for k in ('question', 'positive', 'negative')):
            raise ValueError('Each category requires a question and positive/negative criteria')


def decision(probabilities, policy):
    peak = max(probabilities.values())
    return 'block' if peak >= policy['block_threshold'] else 'review' if peak >= policy['review_threshold'] else 'allow'


async def run_models(manifest, policy, configs, destination, *, keys=None, modality='multimodal', progress=lambda _: None, evaluator=evaluate):
    validate_policy(policy)
    if not configs or modality not in {'multimodal', 'visual', 'text'}:
        raise ValueError('Select at least one provider and a valid modality')
    if not manifest.get('segments'):
        raise ValueError('No input segments')
    check = dict(manifest)
    claimed = check.pop('input_hash')
    if fingerprint(check) != claimed:
        raise ValueError('Input manifest changed after preparation')
    for segment in manifest['segments']:
        for frame in segment['frames']:
            if hashlib.sha256(Path(frame['path']).read_bytes()).hexdigest() != frame['sha256']:
                raise ValueError('Sampled image changed after preparation')
    if len({c.provider for c in configs}) != len(configs):
        raise ValueError('Only one configuration per provider per comparison')
    keys = keys or {}
    for config in configs:
        config.validate()
        if not (keys.get(config.provider) or os.environ.get(config.api_key_env)):
            raise ValueError(f'Missing {config.api_key_env}')
    run_dir = Path(destination) / ('evaluation-' + time.strftime('%Y%m%d-%H%M%S') + '-' + os.urandom(3).hex())
    run_dir.mkdir(parents=True, exist_ok=False)
    report = {'input_hash': claimed, 'policy': policy, 'policy_hash': fingerprint(policy), 'modality': modality,
              'providers': {}, 'sampling': manifest['sampling'], 'localization': 'segment_interval_not_exact_event_boundary'}
    for config in configs:
        rows = []
        for segment in manifest['segments']:
            progress(f"{config.provider}: 片段 {segment['segment_id']}/{len(manifest['segments'])}")
            started = time.perf_counter()
            row = {k: segment[k] for k in ('segment_id', 'start_sec', 'end_sec', 'input_hash')}
            row['visual_evidence'] = segment.get('visual_evidence', 'sampled')
            try:
                if modality == 'visual' and not segment['frames']:
                    raise ValueError('No visual evidence in this interval')
                if modality == 'text' and not segment.get('speech_text', '').strip():
                    raise ValueError('No text evidence in this interval')
                if modality == 'multimodal' and not segment['frames'] and not segment.get('speech_text', '').strip():
                    raise ValueError('No evidence in this interval')
                result = await evaluator(segment, policy, config, keys.get(config.provider) or os.environ[config.api_key_env], modality=modality)
                row.update(result, status='completed', action=decision(result['probabilities'], policy))
            except Exception as error:
                row.update(status='failed', action='review', error_type=type(error).__name__)
            row['elapsed_sec'] = round(time.perf_counter() - started, 3)
            rows.append(row)
            provider_result = {'config': asdict(config), 'segments': rows,
                               'complete': len(rows) == len(manifest['segments']) and all(r['status'] == 'completed' for r in rows)}
            report['providers'][config.provider] = provider_result
            write_json(run_dir / 'report.json', report)
    lines = ['# 短视频审核对照报告', '', f"输入指纹：`{claimed}`", '',
             '概率阈值为实验配置，需用验证集校准。片段时间范围不等于精确违规发生时间。', '',
             '| 模型组 | 片段 | 时间范围（秒） | 状态 | 决策 | 各类分数 |', '|---|---|---|---|---|---|']
    for provider, data in report['providers'].items():
        for row in data['segments']:
            lines.append(f"| {provider} | {row['segment_id']} | {row['start_sec']:.2f}–{row['end_sec']:.2f} | {row['status']} | {row['action']} | {json.dumps(row.get('probabilities', {}), ensure_ascii=False)} |")
    (run_dir / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    report['report_path'] = (run_dir / 'report.json').as_posix()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('video')
    prep.add_argument('--output', required=True)
    prep.add_argument('--asr-config')
    prep.add_argument('--interval', type=float, default=0.5)
    prep.add_argument('--segment-seconds', type=float, default=8)
    run = sub.add_parser('evaluate')
    run.add_argument('inputs')
    run.add_argument('--config', default=str(files('short_video_moderation').joinpath('defaults/moderation.json')))
    run.add_argument('--provider', choices=['jev', 'openai', 'both'], default='both')
    run.add_argument('--modality', choices=['multimodal', 'visual', 'text'], default='multimodal')
    args = parser.parse_args()
    if args.command == 'prepare':
        asr = TranscriptionConfig.from_file(args.asr_config) if args.asr_config else None
        prepare(args.video, args.output, SamplingConfig(interval_sec=args.interval, segment_sec=args.segment_seconds), asr, progress=print)
    else:
        settings = json.loads(Path(args.config).read_text(encoding='utf-8'))
        manifest = json.loads(Path(args.inputs).read_text(encoding='utf-8'))
        configs = [ProviderConfig(**c) for c in settings['providers'] if args.provider in ('both', c['provider'])]
        if not configs:
            raise ValueError('Selected provider not configured')
        report = asyncio.run(run_models(manifest, settings['policy'], configs, Path(args.inputs).parent, modality=args.modality, progress=print))
        print(report['report_path'])
        if any(not p['complete'] for p in report['providers'].values()):
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
