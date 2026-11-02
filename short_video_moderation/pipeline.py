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
from contextlib import AsyncExitStack
from pathlib import Path

from .cloud_asr import WavSlicer, detect_silences, extract_full_audio, plan_speech_chunks
from .providers import ProviderConfig, evaluate
from .sampling import SamplingConfig, dedupe_frames, effective_min_segment, prepare_video
from .alignment import align_evidence
from .media import FFmpegTools, _SUBPROCESS_KWARGS
import subprocess
import httpx
from .transcription import TranscriptionConfig, transcribe_video_blocks


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


# Cloud ASR chunking: pauses quieter than STRICT_DB for at least 0.3 s separate speech; inside long
# continuous sound (background music), dips below LOOSE_DB are used as cut points.
SILENCE_STRICT_DB, SILENCE_STRICT_SEC = -35, 0.3
SILENCE_LOOSE_DB, SILENCE_LOOSE_SEC = -25, 0.15


def prepare(video, destination, sampling, transcription=None, *, asr_key=None, ffmpeg_path=None, ffprobe_path=None,
            progress=lambda _: None, asr_limiter=None):
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

    asr_stats = {}

    def transcribe_audio():
        """Returns (utterances, failed audio intervals)."""
        if not has_audio:
            return [], []
        audio_dir = destination / 'audio'
        audio_dir.mkdir(exist_ok=True)
        audio_manifest = audio_dir / 'intervals.json'
        if transcription.engine != 'mimo-cloud':
            # Local ASR transcribes the whole track; blocks only group the text.
            blocks = []
            start = 0.0
            while start < duration:
                end = min(duration, start + 30.0)
                blocks.append(dict(segment_id=len(blocks) + 1, start_sec=start, end_sec=end))
                start = end
            write_json(audio_manifest, {'video_id': Path(video).stem, 'segments': blocks})
            transcript = transcribe_video_blocks(video, audio_manifest, config=transcription,
                                                 output_dir=audio_dir, api_key=asr_key)
            return [u for segment in transcript['segments'] for u in segment.get('utterances', [])], []
        # Cloud ASR has no sentence timestamps: decode once, cut at pauses into chunks no longer than a
        # review window, upload only chunks with sound, and use each chunk's range as its timestamp.
        wav = audio_dir / 'audio.wav'
        try:
            extract_full_audio(Path(video), wav, ffmpeg_path=transcription.ffmpeg_path)
            silences = detect_silences(wav, noise_db=SILENCE_STRICT_DB, min_silence_sec=SILENCE_STRICT_SEC,
                                       ffmpeg_path=transcription.ffmpeg_path)
            dips = detect_silences(wav, noise_db=SILENCE_LOOSE_DB, min_silence_sec=SILENCE_LOOSE_SEC,
                                   ffmpeg_path=transcription.ffmpeg_path)
            blocks = plan_speech_chunks(duration, silences, dips, max_sec=sampling.segment_sec)
            write_json(audio_manifest, {'video_id': Path(video).stem, 'segments': blocks})
            uploads = sum(1 for b in blocks if not b['skip'])
            finished = [0]

            def asr_progress(message, _fraction):
                if message.endswith('云端语音识别完成'):
                    finished[0] += 1
                    progress(f'语音识别 {finished[0]}/{uploads}')

            if uploads:
                progress(f'语音识别 0/{uploads}')
            transcript = transcribe_video_blocks(video, audio_manifest, config=transcription, output_dir=audio_dir,
                                                 api_key=asr_key, audio_extractor=WavSlicer(wav),
                                                 cloud_limiter=asr_limiter, progress_callback=asr_progress)
        finally:
            wav.unlink(missing_ok=True)
        stats = transcript['transcription'].get('cloud_statistics', {})
        asr_stats.update(chunks=len(blocks), uploaded=uploads,
                         uploaded_seconds=round(sum(b['end_sec'] - b['start_sec'] for b in blocks if not b['skip']), 3),
                         skipped_silent=len(blocks) - uploads, failed=stats.get('failed_block_count', 0))
        failed = [(s['start_sec'], s['end_sec']) for s in transcript['segments'] if s.get('asr_status') == 'failed']
        return [u for segment in transcript['segments'] for u in segment.get('utterances', [])], failed

    progress('并行处理：画面抽样与音轨转写')
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix='moderation-prepare') as pool:
        audio_future = pool.submit(transcribe_audio)
        visual_future = pool.submit(prepare_video, video, destination, sampling,
                                    ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path)
        manifest, (utterances, failed_audio) = visual_future.result(), audio_future.result()
    progress('按讲话时间组合画面；补齐静音区间')
    frames = [frame for segment in manifest['segments'] for frame in segment['frames']]
    precision = 'absent' if not has_audio else 'speech_chunk' if transcription.engine == 'mimo-cloud' else 'asr_segment'
    manifest['segments'] = align_evidence(frames, utterances, duration, max_seconds=sampling.segment_sec,
                                          max_frames=sampling.max_frames_per_segment,
                                          min_seconds=effective_min_segment(sampling),
                                          audio_status='transcribed' if has_audio else 'absent', precision=precision,
                                          failed_audio=failed_audio)
    manifest['alignment'] = {'strategy': 'speech_first_with_silent_windows', 'max_seconds': sampling.segment_sec,
                             'min_seconds': effective_min_segment(sampling), 'precision': precision}
    if asr_stats:
        manifest['asr_statistics'] = asr_stats
    # Drop near-identical frames inside each window (every window keeps its first frame).
    sampled = kept = 0
    for segment in manifest['segments']:
        unique = dedupe_frames(segment['frames'], sampling)
        keep = {frame['path'] for frame in unique}
        for frame in segment['frames']:
            if frame['path'] not in keep:
                Path(frame['path']).unlink(missing_ok=True)
        sampled += len(segment['frames'])
        kept += len(unique)
        segment['frames'] = [{k: v for k, v in frame.items() if k != '_sig'} for frame in unique]
        segment['screenshot_path'] = segment['frames'][0]['path'] if segment['frames'] else None
    manifest['frame_statistics'] = {'sampled': sampled, 'kept': kept}
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


def missing_evidence(segment, modality):
    """Why a window cannot be judged in this modality: None, a skip reason, or 'asr_failed'."""
    has_frames = bool(segment['frames'])
    has_text = bool(segment.get('speech_text', '').strip())
    asr_failed = segment.get('audio_status') == 'asr_failed'
    if modality == 'visual':
        return None if has_frames else 'no_visual_evidence'
    if modality == 'text':
        return None if has_text else 'asr_failed' if asr_failed else 'no_speech'
    return None if has_frames or has_text else 'asr_failed' if asr_failed else 'no_evidence'


async def run_models(manifest, policy, configs, destination, *, keys=None, modality='multimodal', progress=lambda _: None,
                     evaluator=evaluate, limiters=None):
    """Judge every window with every provider, concurrently.

    Requests per provider are capped by ``limiters[provider]`` (shared across videos) when given,
    otherwise by ``config.max_concurrency``. Windows without evidence for the modality are recorded
    as ``skipped``; windows whose speech could not be transcribed are judged on frames and held for
    review (``evidence: asr_failed``).
    """
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
    segments = manifest['segments']
    total = len(segments)
    rows = {config.provider: {} for config in configs}
    done = {config.provider: 0 for config in configs}
    local = {config.provider: asyncio.Semaphore(config.max_concurrency) for config in configs}

    def slot(provider):
        if limiters and provider in limiters:
            return limiters[provider].async_slot()
        return local[provider]

    def write_report():
        for config in configs:
            ordered = [rows[config.provider][s['segment_id']] for s in segments if s['segment_id'] in rows[config.provider]]
            report['providers'][config.provider] = {
                'config': asdict(config), 'segments': ordered,
                'complete': len(ordered) == total and all(r['status'] in ('completed', 'skipped') for r in ordered)}
        write_json(run_dir / 'report.json', report)

    async def judge(config, segment, client):
        row = {k: segment[k] for k in ('segment_id', 'start_sec', 'end_sec', 'input_hash')}
        row['visual_evidence'] = segment.get('visual_evidence', 'sampled')
        started = time.perf_counter()
        reason = missing_evidence(segment, modality)
        if reason == 'asr_failed':
            row.update(status='failed', action='review', error_type='asr_failed')
        elif reason:
            row.update(status='skipped', action='allow', skip_reason=reason)
        else:
            extra = {'client': client} if client is not None else {}
            async with slot(config.provider):
                started = time.perf_counter()
                try:
                    result = await evaluator(segment, policy, config, keys.get(config.provider) or os.environ[config.api_key_env],
                                             modality=modality, **extra)
                    row.update(result, status='completed', action=decision(result['probabilities'], policy))
                    if segment.get('audio_status') == 'asr_failed' and modality != 'visual':
                        # Speech was not available: never let this window pass unseen.
                        row['evidence'] = 'asr_failed'
                        if row['action'] == 'allow':
                            row['action'] = 'review'
                except Exception as error:
                    row.update(status='failed', action='review', error_type=getattr(error, 'code', None) or type(error).__name__)
        row['elapsed_sec'] = round(time.perf_counter() - started, 3)
        rows[config.provider][segment['segment_id']] = row
        done[config.provider] += 1
        progress(f"{config.provider}: 完成 {done[config.provider]}/{total}")
        write_report()

    async with AsyncExitStack() as stack:
        clients = {}
        if evaluator is evaluate:
            for config in configs:
                limit = limiters[config.provider].limit if limiters and config.provider in limiters else config.max_concurrency
                clients[config.provider] = await stack.enter_async_context(httpx.AsyncClient(
                    timeout=config.timeout_sec, limits=httpx.Limits(max_connections=limit, max_keepalive_connections=limit)))
        for config in configs:
            progress(f"{config.provider}: 完成 0/{total}")
        await asyncio.gather(*(judge(config, segment, clients.get(config.provider))
                               for config in configs for segment in segments))
    write_report()
    lines = ['# 短视频审核对照报告', '', f"输入指纹：`{claimed}`", '',
             '概率阈值为实验配置，需用验证集校准。片段时间范围不等于精确违规发生时间。', '',
             '| 模型组 | 片段 | 时间范围（秒） | 状态 | 决策 | 各类分数 |', '|---|---|---|---|---|---|']
    if manifest.get('asr_statistics'):
        stats = manifest['asr_statistics']
        lines[4:4] = [f"云端语音识别：{stats['uploaded']} 段上传（{stats['uploaded_seconds']} 秒），"
                      f"跳过静音 {stats['skipped_silent']} 段，失败 {stats['failed']} 段。", '']
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
