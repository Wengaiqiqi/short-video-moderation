"""Speech-led windows with complete visual coverage, including silent intervals."""
import math


def align_evidence(frames, utterances, duration, *, max_seconds=8.0, max_frames=16, audio_status='transcribed', precision='asr_segment'):
    if not math.isfinite(duration) or duration <= 0 or max_seconds <= 0 or max_frames < 1:
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
    coarse = sorted(boundaries)
    # Silent gaps and very long utterances retain bounded independent windows.
    for start, end in zip(coarse, coarse[1:]):
        count = math.ceil((end - start) / max_seconds)
        boundaries.update(start + i * max_seconds for i in range(1, count))
    bounded = sorted(boundaries)
    for start, end in zip(bounded, bounded[1:]):
        window_frames = [f for f in frames if start <= f['time_sec'] < end]
        boundaries.update(window_frames[i]['time_sec'] for i in range(max_frames, len(window_frames), max_frames))
    times = sorted(boundaries)
    result = []
    for start, end in zip(times, times[1:]):
        pictures = [f for f in frames if start <= f['time_sec'] < end]
        lines = [u for u in speech if u['start_sec'] < end and u['end_sec'] > start]
        result.append(dict(segment_id=len(result) + 1, start_sec=start, end_sec=end,
                           frames=pictures, screenshot_path=pictures[0]['path'] if pictures else None,
                           speech_text='\n'.join(dict.fromkeys(u['text'] for u in lines)),
                           utterances=lines, audio_status=audio_status, alignment_precision=precision,
                           visual_evidence='sampled' if pictures else 'no_sample_in_interval'))
    return result
