"""Speech-led windows with complete visual coverage, including silent intervals."""
import math


def _merge_short(times, min_seconds):
    """Drop boundaries that would leave a window shorter than min_seconds (start and end are kept)."""
    if min_seconds <= 0 or len(times) <= 2:
        return times
    kept = [times[0]]
    for t in times[1:-1]:
        if t - kept[-1] >= min_seconds:
            kept.append(t)
    if len(kept) > 1 and times[-1] - kept[-1] < min_seconds:
        kept.pop()
    kept.append(times[-1])
    return kept


def align_evidence(frames, utterances, duration, *, max_seconds=8.0, max_frames=16, min_seconds=1.0,
                   audio_status='transcribed', precision='asr_segment', failed_audio=()):
    """Cut the video into review windows.

    Windows start and end at speech boundaries, so a sentence is not split between windows; silent
    stretches get their own windows. Windows shorter than ``min_seconds`` are merged into a neighbour
    (pauses between sentences would otherwise become empty windows), longer than ``max_seconds`` are cut
    evenly, and windows with more than ``max_frames`` frames are split into equal frame counts.
    Windows overlapping ``failed_audio`` (cloud ASR blocks that failed) are marked ``asr_failed``.
    """
    if not math.isfinite(duration) or duration <= 0 or max_seconds <= 0 or max_frames < 1 or min_seconds < 0:
        raise ValueError('Invalid alignment limits')
    speech = []
    boundaries = {0.0, duration}
    for item in utterances:
        start, end = float(item['start_sec']), float(item['end_sec'])
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError('Invalid ASR timestamps')
        start, end = min(start, duration), min(end, duration)
        if end <= start or not item['text'].strip():
            continue
        speech.append(dict(start_sec=start, end_sec=end, text=item['text']))
        boundaries.update((start, end))
    coarse = _merge_short(sorted(boundaries), min_seconds)
    # Silent gaps and very long utterances retain bounded independent windows.
    bounded = set(coarse)
    for start, end in zip(coarse, coarse[1:]):
        count = math.ceil((end - start) / max_seconds - 1e-9)
        bounded.update(start + i * (end - start) / count for i in range(1, count))
    times = sorted(bounded)
    # Frame budget: split busy windows into parts with equal frame counts (no slivers).
    final = set(times)
    for start, end in zip(times, times[1:]):
        window_frames = [f for f in frames if start <= f['time_sec'] < end]
        parts = math.ceil(len(window_frames) / max_frames)
        if parts > 1:
            final.update(window_frames[round(i * len(window_frames) / parts)]['time_sec'] for i in range(1, parts))
    times = sorted(final)
    failed = [(float(a), float(b)) for a, b in failed_audio]
    result = []
    for start, end in zip(times, times[1:]):
        pictures = [f for f in frames if start <= f['time_sec'] < end]
        lines = [u for u in speech if u['start_sec'] < end and u['end_sec'] > start]
        status = 'asr_failed' if any(a < end and b > start for a, b in failed) else audio_status
        result.append(dict(segment_id=len(result) + 1, start_sec=start, end_sec=end,
                           frames=pictures, screenshot_path=pictures[0]['path'] if pictures else None,
                           speech_text='\n'.join(dict.fromkeys(u['text'] for u in lines)),
                           utterances=lines, audio_status=status, alignment_precision=precision,
                           visual_evidence='sampled' if pictures else 'no_sample_in_interval'))
    return result
