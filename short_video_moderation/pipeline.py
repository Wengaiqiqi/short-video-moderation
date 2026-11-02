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
from .errors import Cancelled
from .providers import ProviderConfig, evaluate, evaluate_transcript
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
            progress=lambda _: None, asr_limiter=None, should_stop=None):
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
            extract_full_audio(Path(video), wav, ffmpeg_path=transcription.ffmpeg_path, should_stop=should_stop)
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
                                                 cloud_limiter=asr_limiter, progress_callback=asr_progress,
                                                 should_stop=should_stop)
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
                                    ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path, should_stop=should_stop)
        manifest, (utterances, failed_audio) = visual_future.result(), audio_future.result()
    if should_stop and should_stop():
        raise Cancelled()
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


def _check_thresholds(low, high, where):
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (low, high)) or not 0 <= low < high <= 1:
        raise ValueError(f'{where}: require 0 <= review_threshold < block_threshold <= 1')


def validate_policy(policy):
    if not policy.get('version') or not policy.get('categories'):
        raise ValueError('Policy requires version and categories')
    _check_thresholds(policy['review_threshold'], policy['block_threshold'], 'policy')
    for key, rule in policy['categories'].items():
        if not all(isinstance(rule.get(k), str) and rule[k].strip() for k in ('question', 'positive', 'negative')):
            raise ValueError('Each category requires a question and positive/negative criteria')
        if 'review_threshold' in rule or 'block_threshold' in rule:
            _check_thresholds(rule.get('review_threshold', policy['review_threshold']),
                              rule.get('block_threshold', policy['block_threshold']), key)


def category_thresholds(policy, category):
    """(review, block) for one category; a category may override the policy-wide thresholds."""
    rule = policy['categories'].get(category, {})
    return rule.get('review_threshold', policy['review_threshold']), rule.get('block_threshold', policy['block_threshold'])


def decision(probabilities, policy):
    action = 'allow'
    for category, value in probabilities.items():
        review, block = category_thresholds(policy, category)
        if value >= block:
            return 'block'
        if value >= review:
            action = 'review'
    return action


def usage_totals(rows):
    """Sum every numeric usage counter (input/output/total tokens…) over completed rows."""
    totals = {}
    for row in rows:
        for key, value in (row.get('usage') or {}).items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                totals[key] = totals.get(key, 0) + value
    return totals


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


def transcript_sentences(segments):
    """The whole transcript as numbered sentences [{id, start_sec, end_sec, text, segments}].

    Each utterance appears once even when it overlaps several windows; ``segments`` lists those windows.
    """
    seen = {}
    for segment in segments:
        for utterance in segment.get('utterances') or []:
            text = str(utterance.get('text', '')).strip()
            if text:
                key = (round(float(utterance['start_sec']), 3), round(float(utterance['end_sec']), 3), text)
                seen.setdefault(key, set()).add(segment['segment_id'])
    ordered = sorted(seen.items(), key=lambda item: (item[0][0], item[0][1]))
    return [{'id': index + 1, 'start_sec': start, 'end_sec': end, 'text': text, 'segments': sorted(ids)}
            for index, ((start, end, text), ids) in enumerate(ordered)]


CONTEXT_MAX_GAP_SEC = 10.0


def speech_contexts(segments, sentences, max_gap=CONTEXT_MAX_GAP_SEC):
    """The sentence just before and just after each window ({segment_id: {before, after}}).

    Neighbours further than ``max_gap`` seconds from the window are left out: they are not context.
    """
    out = {}
    for segment in segments:
        sid, start, end = segment['segment_id'], segment['start_sec'], segment['end_sec']
        inside = [i for i, s in enumerate(sentences) if sid in s['segments']]
        if inside:
            before_i, after_i = inside[0] - 1, inside[-1] + 1
        else:
            before_i = max((i for i, s in enumerate(sentences) if s['end_sec'] <= start + 1e-6), default=-1)
            after_i = min((i for i, s in enumerate(sentences) if s['start_sec'] >= end - 1e-6), default=len(sentences))
        context = {}
        if before_i >= 0 and start - sentences[before_i]['end_sec'] <= max_gap:
            context['before'] = sentences[before_i]['text']
        if after_i < len(sentences) and sentences[after_i]['start_sec'] - end <= max_gap:
            context['after'] = sentences[after_i]['text']
        if context:
            out[sid] = context
    return out


TRANSCRIPT_MAX_CHARS = 12000


def transcript_passages(sentences, max_chars=TRANSCRIPT_MAX_CHARS, overlap=3):
    """Split a very long transcript into passages of at most ``max_chars``, overlapping by a few sentences."""
    passages, start = [], 0
    while start < len(sentences):
        end, size = start, 0
        while end < len(sentences) and (end == start or size + len(sentences[end]['text']) <= max_chars):
            size += len(sentences[end]['text'])
            end += 1
        passages.append(sentences[start:end])
        if end >= len(sentences):
            break
        start = max(start + 1, end - overlap)
    return passages


def merge_transcript_results(results, categories):
    """Passages of one transcript: the highest score per category, the union of the listed sentences."""
    merged = {'probabilities': {key: max(r['probabilities'][key] for r in results) for key in categories},
              'sentences': {}, 'model': results[0].get('model'), 'score_kind': results[0].get('score_kind'),
              'usage': usage_totals(results)}
    for result in results:
        for key, ids in (result.get('sentences') or {}).items():
            merged['sentences'][key] = sorted(set(merged['sentences'].get(key, [])) | set(ids))
    return merged


async def run_models(manifest, policy, configs, destination, *, keys=None, modality='multimodal', progress=lambda _: None,
                     evaluator=evaluate, limiters=None, should_stop=None, stop_on_block=False, only_segments=None, previous=None,
                     full_text=False, speech_context=False, transcript_evaluator=evaluate_transcript):
    """Judge every window with every provider, concurrently.

    Requests per provider are capped by ``limiters[provider]`` (shared across videos) when given,
    otherwise by ``config.max_concurrency``. Windows without evidence for the modality are recorded
    as ``skipped``; windows whose speech could not be transcribed are judged on frames and held for
    review (``evidence: asr_failed``).

    ``only_segments`` ({provider: {segment_id}}) re-judges just those windows; the other rows are copied
    from ``previous`` (an earlier report on the same inputs), e.g. to retry failed windows.
    ``stop_on_block`` skips windows not yet sent once any window is blocked (the verdict cannot change).
    ``should_stop`` is polled before each request; returning True raises ``Cancelled``.

    ``full_text`` also judges the whole transcript once per provider (sent first, alongside the windows), so
    meaning spread over several sentences is not lost by the window cut; the result is stored as the
    provider's ``transcript`` entry and never stops the windows. ``speech_context`` gives each window the
    sentence before and after it. Neither applies to the visual modality.
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
    if previous is not None and previous.get('input_hash') != claimed:
        raise ValueError('Previous report belongs to different inputs')
    report = {'input_hash': claimed, 'policy': policy, 'policy_hash': fingerprint(policy), 'modality': modality,
              'providers': {}, 'sampling': manifest['sampling'], 'localization': 'segment_interval_not_exact_event_boundary',
              'video_path': manifest.get('video_path'), 'video_id': manifest.get('video_id'),
              'duration_sec': manifest.get('duration_sec'), 'asr_statistics': manifest.get('asr_statistics'),
              'frame_statistics': manifest.get('frame_statistics'), 'created_at': time.strftime('%Y-%m-%dT%H:%M:%S')}
    if previous is not None:
        report['retry_of'] = previous.get('report_path')
    segments = manifest['segments']
    total = len(segments)
    spoken = modality != 'visual'
    sentences = transcript_sentences(segments) if spoken else []
    report['full_text'] = bool(full_text and spoken)
    report['speech_context'] = bool(speech_context and spoken)
    if report['full_text']:
        report['transcript'] = sentences
    contexts = speech_contexts(segments, sentences) if report['speech_context'] else {}
    rows = {config.provider: {} for config in configs}
    todo = {config.provider: [s for s in segments if only_segments is None
                              or s['segment_id'] in only_segments.get(config.provider, ())] for config in configs}
    for config in configs:
        # Rows that are not re-judged come from the earlier report unchanged.
        if only_segments is not None:
            kept = {r['segment_id']: r for r in (previous or {}).get('providers', {}).get(config.provider, {}).get('segments', [])}
            redo = {s['segment_id'] for s in todo[config.provider]}
            rows[config.provider].update({sid: row for sid, row in kept.items() if sid not in redo})
    whole = {}
    text_todo = []
    for config in configs:
        if not report['full_text']:
            continue
        earlier = (previous or {}).get('providers', {}).get(config.provider, {}).get('transcript') if only_segments is not None else None
        if earlier and earlier.get('status') in ('completed', 'skipped') and earlier.get('sentence_count') == len(sentences):
            whole[config.provider] = earlier
        else:
            text_todo.append(config)
    planned = {config.provider: len(todo[config.provider]) + (config in text_todo) for config in configs}
    blocked = [False]
    done = {config.provider: 0 for config in configs}
    local = {config.provider: asyncio.Semaphore(config.max_concurrency) for config in configs}

    def slot(provider):
        if limiters and provider in limiters:
            return limiters[provider].async_slot()
        return local[provider]

    def write_report():
        for config in configs:
            ordered = [rows[config.provider][s['segment_id']] for s in segments if s['segment_id'] in rows[config.provider]]
            text = whole.get(config.provider)
            entry = report['providers'][config.provider] = {
                'config': asdict(config), 'segments': ordered, 'usage': usage_totals(ordered + ([text] if text else [])),
                'complete': len(ordered) == total and all(r['status'] in ('completed', 'skipped') for r in ordered)
                and (not report['full_text'] or (text or {}).get('status') in ('completed', 'skipped'))}
            if report['full_text']:
                entry['transcript'] = text
        write_json(run_dir / 'report.json', report)

    def finished(provider):
        done[provider] += 1
        progress(f"{provider}: 完成 {done[provider]}/{planned[provider]}")
        write_report()

    def api_key(config):
        return keys.get(config.provider) or os.environ[config.api_key_env]

    async def judge_text(config, client):
        row = {'sentence_count': len(sentences)}
        started = time.perf_counter()
        if not sentences:
            row.update(status='skipped', action='allow', skip_reason='no_speech')
        elif stop_on_block and blocked[0]:
            row.update(status='skipped', action='allow', skip_reason='stopped_after_block')
        else:
            if should_stop and should_stop():
                raise Cancelled()
            extra = {'client': client} if client is not None else {}
            passages = transcript_passages(sentences)

            async def one(passage):
                async with slot(config.provider):
                    if should_stop and should_stop():
                        raise Cancelled()
                    return await transcript_evaluator(passage, policy, config, api_key(config), **extra)
            try:
                # A single passage is awaited in place so it takes a request slot before any window does.
                calls = [one(p) for p in passages]
                results = [await calls[0]] if len(calls) == 1 else await asyncio.gather(*calls)
                merged = merge_transcript_results(results, policy['categories'])
                listed = {i for ids in merged['sentences'].values() for i in ids}
                row.update(merged, status='completed', action=decision(merged['probabilities'], policy),
                           passages=len(passages),
                           windows=sorted({sid for s in sentences if s['id'] in listed for sid in s['segments']}))
            except Cancelled:
                raise
            except Exception as error:
                row.update(status='failed', action='review', error_type=getattr(error, 'code', None) or type(error).__name__)
        row['elapsed_sec'] = round(time.perf_counter() - started, 3)
        whole[config.provider] = row
        finished(config.provider)

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
            if should_stop and should_stop():
                raise Cancelled()
            async with slot(config.provider):
                started = time.perf_counter()
                if should_stop and should_stop():
                    raise Cancelled()
                if stop_on_block and blocked[0]:
                    row.update(status='skipped', action='allow', skip_reason='stopped_after_block')
                    rows[config.provider][segment['segment_id']] = row
                    finished(config.provider)
                    return
                try:
                    sent = dict(segment, speech_context=contexts[segment['segment_id']]) if segment['segment_id'] in contexts else segment
                    result = await evaluator(sent, policy, config, api_key(config), modality=modality, **extra)
                    row.update(result, status='completed', action=decision(result['probabilities'], policy))
                    if row['action'] == 'block':
                        blocked[0] = True
                    if segment.get('audio_status') == 'asr_failed' and modality != 'visual':
                        # Speech was not available: never let this window pass unseen.
                        row['evidence'] = 'asr_failed'
                        if row['action'] == 'allow':
                            row['action'] = 'review'
                except Exception as error:
                    row.update(status='failed', action='review', error_type=getattr(error, 'code', None) or type(error).__name__)
        row['elapsed_sec'] = round(time.perf_counter() - started, 3)
        rows[config.provider][segment['segment_id']] = row
        finished(config.provider)

    async with AsyncExitStack() as stack:
        clients = {}
        if evaluator is evaluate or (text_todo and transcript_evaluator is evaluate_transcript):
            for config in configs:
                limit = limiters[config.provider].limit if limiters and config.provider in limiters else config.max_concurrency
                clients[config.provider] = await stack.enter_async_context(httpx.AsyncClient(
                    timeout=config.timeout_sec, limits=httpx.Limits(max_connections=limit, max_keepalive_connections=limit)))
        for config in configs:
            progress(f"{config.provider}: 完成 0/{planned[config.provider]}")
        # The full-text requests go first so they are not queued behind every window.
        await asyncio.gather(*(judge_text(config, clients.get(config.provider)) for config in text_todo),
                             *(judge(config, segment, clients.get(config.provider))
                               for config in configs for segment in todo[config.provider]))
    write_report()
    lines = ['# 短视频审核对照报告', '', f"输入指纹：`{claimed}`", '',
             '概率阈值为实验配置，需用验证集校准。片段时间范围不等于精确违规发生时间。', '',
             '| 模型组 | 片段 | 时间范围（秒） | 状态 | 决策 | 各类分数 |', '|---|---|---|---|---|---|']
    if manifest.get('asr_statistics'):
        stats = manifest['asr_statistics']
        lines[4:4] = [f"云端语音识别：{stats['uploaded']} 段上传（{stats['uploaded_seconds']} 秒），"
                      f"跳过静音 {stats['skipped_silent']} 段，失败 {stats['failed']} 段。", '']
    for provider, data in report['providers'].items():
        text = data.get('transcript')
        if text:
            flagged = '、'.join(f"{key}: {ids}" for key, ids in (text.get('sentences') or {}).items()) or '无'
            lines.insert(4, f"全文判断（{provider}）：{text['status']} / {text['action']}，"
                            f"分数 {json.dumps(text.get('probabilities', {}), ensure_ascii=False)}，违规语句 {flagged}。")
            lines.insert(5, '')
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
    run.add_argument('--no-full-text', action='store_true', help='skip the whole-transcript judgement')
    run.add_argument('--no-speech-context', action='store_true', help='do not give windows the neighbouring sentences')
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
        report = asyncio.run(run_models(manifest, settings['policy'], configs, Path(args.inputs).parent, modality=args.modality,
                                        progress=print, full_text=not args.no_full_text,
                                        speech_context=not args.no_speech_context))
        print(report['report_path'])
        if any(not p['complete'] for p in report['providers'].values()):
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
