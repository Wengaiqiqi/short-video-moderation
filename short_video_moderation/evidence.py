"""What a reviewer needs to check a window: its frames, transcript and a playable clip; long-video splitting."""
from __future__ import annotations

import base64
import io
import json
import subprocess
from pathlib import Path

from PIL import Image

from .errors import UserFacingError
from .library import job_dir, read_json, video_fingerprint
from .media import FFmpegTools, _SUBPROCESS_KWARGS
from .paths import runtime_root, temp_root


def _thumbnail(path, width):
    with Image.open(path) as image:
        image = image.convert('RGB')
        image.thumbnail((width, width * 4))
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=80)
    return 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')


def segment_evidence(report_path, segment_id, *, max_frames=8, width=320):
    """Frames (as small JPEG data URLs) and transcript of one window, read from the prepared inputs."""
    job = job_dir(report_path)
    inputs = read_json(job / 'inputs.json')
    segment = next((s for s in inputs['segments'] if s['segment_id'] == int(segment_id)), None)
    if segment is None:
        raise ValueError('找不到该片段')
    frames = segment.get('frames', [])
    if len(frames) > max_frames:
        frames = [frames[round(i * (len(frames) - 1) / (max_frames - 1))] for i in range(max_frames)]
    pictures = []
    for frame in frames:
        path = Path(frame['path']).resolve()
        if job not in path.parents or not path.is_file():
            continue  # only images that belong to this review
        pictures.append({'time_sec': frame['time_sec'], 'data_url': _thumbnail(path, width)})
    return {'segment_id': segment['segment_id'], 'start_sec': segment['start_sec'], 'end_sec': segment['end_sec'],
            'speech_text': segment.get('speech_text', ''), 'utterances': segment.get('utterances', []),
            'audio_status': segment.get('audio_status'), 'alignment_precision': segment.get('alignment_precision'),
            'frame_count': len(segment.get('frames', [])), 'frames': pictures, 'video_path': inputs.get('video_path')}


def segment_clip(video_path, start_sec, end_sec, *, ffmpeg_path=None, max_sec=30.0, height=360):
    """A short playable clip of one window, as (mime type, base64). Tries H.264/MP4, then VP8/WebM."""
    video = Path(str(video_path))
    if not video.is_file():
        raise FileNotFoundError(f'视频文件不存在：{video}')
    start = max(0.0, float(start_sec))
    duration = min(max_sec, max(0.5, float(end_sec) - start))
    ffmpeg = FFmpegTools._resolve(ffmpeg_path or None, 'ffmpeg')
    common = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{start:.3f}', '-i', str(video),
              '-t', f'{duration:.3f}', '-map', '0:v:0', '-map', '0:a:0?', '-vf', f'scale=-2:{int(height)}']
    attempts = [
        ('video/mp4', '.mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
                               '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart']),
        ('video/webm', '.webm', ['-c:v', 'libvpx', '-b:v', '600k', '-deadline', 'realtime', '-c:a', 'libvorbis']),
    ]
    for mime, suffix, codec in attempts:
        target = temp_root() / f'clip-{video_fingerprint(video)[:12]}-{int(start * 1000)}{suffix}'
        try:
            result = subprocess.run(common + codec + [str(target)], capture_output=True, timeout=120, **_SUBPROCESS_KWARGS)
            if result.returncode == 0 and target.is_file() and target.stat().st_size > 0:
                return mime, base64.b64encode(target.read_bytes()).decode('ascii')
        except subprocess.TimeoutExpired:
            pass
        finally:
            target.unlink(missing_ok=True)
    raise UserFacingError('无法生成片段视频（FFmpeg 缺少 H.264 和 VP8 编码器）')


def probe_duration(video_path, *, ffmpeg_path=None, ffprobe_path=None):
    return FFmpegTools(ffmpeg_path=ffmpeg_path or None, ffprobe_path=ffprobe_path or None).probe(Path(video_path)).duration_sec


def split_video(video_path, *, part_sec=590.0, ffmpeg_path=None, ffprobe_path=None):
    """Cut a long video into parts of about part_sec seconds without re-encoding (cut at key frames).

    Parts are cached by file content, so adding the same long video again reuses them.
    """
    video = Path(str(video_path))
    if not video.is_file():
        raise FileNotFoundError(f'视频文件不存在：{video}')
    folder = runtime_root() / 'splits' / video_fingerprint(video)[:20]
    manifest = folder / 'parts.json'
    if manifest.is_file():
        try:
            parts = read_json(manifest)
            if parts and all(Path(p['path']).is_file() for p in parts):
                return parts
        except (OSError, ValueError, KeyError):
            pass
    folder.mkdir(parents=True, exist_ok=True)
    suffix = video.suffix.lower() if video.suffix.lower() in ('.mp4', '.mkv', '.mov', '.webm') else '.mkv'
    ffmpeg = FFmpegTools._resolve(ffmpeg_path or None, 'ffmpeg')
    result = subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(video), '-map', '0:v:0',
                             '-map', '0:a?', '-c', 'copy', '-f', 'segment', '-segment_time', f'{float(part_sec):.1f}',
                             '-reset_timestamps', '1', str(folder / f'{video.stem}-part%03d{suffix}')],
                            capture_output=True, timeout=1800, **_SUBPROCESS_KWARGS)
    files = sorted(folder.glob(f'{video.stem}-part*{suffix}'))
    if result.returncode != 0 or not files:
        raise UserFacingError('长视频切分失败，请确认视频文件完整。')
    parts, start = [], 0.0
    for path in files:
        length = probe_duration(path, ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path)
        parts.append({'path': path.as_posix(), 'start_sec': round(start, 3), 'end_sec': round(start + length, 3)})
        start += length
    manifest.write_text(json.dumps(parts, ensure_ascii=False, indent=2), encoding='utf-8')
    return parts
