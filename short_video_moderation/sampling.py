"""Short-video sampling: periodic coverage plus scene-change frames, preserving temporal coverage."""
from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageOps

from .errors import UserFacingError
from .media import FFmpegTools, _SUBPROCESS_KWARGS, run_cancellable


@dataclass(frozen=True)
class SamplingConfig:
    interval_sec: float = 0.5
    scene_threshold: float = 0.25
    segment_sec: float = 8.0
    # Windows shorter than this are merged into a neighbour (pauses between sentences, video ends).
    min_segment_sec: float = 1.0
    min_scene_gap_sec: float = 0.15
    max_frames_per_segment: int = 16
    max_duration_sec: float = 600.0
    # Drop a frame only when it is nearly identical to the last kept one (bits differing out of 256),
    # but always keep one frame every keepalive seconds. 0 disables de-duplication.
    dedupe_max_distance: int = 3
    dedupe_keepalive_sec: float = 2.0

    def validate(self):
        for value in (self.interval_sec, self.segment_sec, self.min_scene_gap_sec, self.max_duration_sec):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Sampling durations must be finite and positive")
        if not 0 < self.scene_threshold <= 1 or not 1 <= self.max_frames_per_segment <= 32:
            raise ValueError("Invalid scene threshold or frame batch size")
        if self.min_scene_gap_sec > self.interval_sec:
            raise ValueError("Scene gap cannot exceed periodic interval")
        if not math.isfinite(self.min_segment_sec) or self.min_segment_sec < 0:
            raise ValueError("Minimum window must be zero or positive")
        if not 0 <= self.dedupe_max_distance <= 32 or not math.isfinite(self.dedupe_keepalive_sec) \
                or self.dedupe_keepalive_sec < self.interval_sec:
            raise ValueError("Invalid frame de-duplication settings")


def effective_min_segment(config: SamplingConfig) -> float:
    """Short windows merge up to min_segment_sec, but never more than half the maximum window."""
    return min(config.min_segment_sec, config.segment_sec / 2)


def frame_signature(image: Image.Image) -> list[str]:
    """256-bit difference hash (structure) plus a 4x4 colour thumbnail (colour and brightness), as hex.

    The hash alone ignores global colour, so two flat frames of different colours would look equal.
    """
    small = image.convert('L').resize((17, 16), Image.Resampling.BILINEAR)
    pixels = list(small.getdata())
    bits = 0
    for row in range(16):
        for col in range(16):
            left, right = pixels[row * 17 + col], pixels[row * 17 + col + 1]
            bits = (bits << 1) | (left > right)
    return [f'{bits:064x}', image.convert('RGB').resize((4, 4), Image.Resampling.BOX).tobytes().hex()]


def _near_duplicate(a, b, max_distance):
    hash_a, thumb_a = int(a[0], 16), bytes.fromhex(a[1])
    hash_b, thumb_b = int(b[0], 16), bytes.fromhex(b[1])
    return (bin(hash_a ^ hash_b).count('1') <= max_distance
            and max(abs(x - y) for x, y in zip(thumb_a, thumb_b)) <= 12)


def dedupe_frames(frames: list[dict], config: SamplingConfig) -> list[dict]:
    """Within one review window: keep the first frame, scene changes and one frame per keepalive
    period; drop only frames nearly identical to the last kept one. Frames without a signature stay."""
    if config.dedupe_max_distance <= 0:
        return list(frames)
    kept: list[dict] = []
    for frame in frames:
        last = kept[-1] if kept else None
        if (last is None or '_sig' not in frame or '_sig' not in last
                or frame['time_sec'] - last['time_sec'] >= config.dedupe_keepalive_sec
                or not _near_duplicate(frame['_sig'], last['_sig'], config.dedupe_max_distance)):
            kept.append(frame)
    return kept


def group_frames(frames: list[dict], duration: float, config: SamplingConfig) -> list[dict]:
    """Split busy windows instead of dropping frames to satisfy the request budget."""
    groups: list[list[dict]] = []
    for frame in frames:
        if not groups or len(groups[-1]) >= config.max_frames_per_segment or (
            frame['time_sec'] - groups[-1][0]['time_sec'] >= config.segment_sec
        ):
            groups.append([])
        groups[-1].append(frame)
    return [dict(segment_id=i + 1, start_sec=0.0 if i == 0 else group[0]['time_sec'],
                 end_sec=groups[i + 1][0]['time_sec'] if i + 1 < len(groups) else duration,
                 screenshot_path=group[0]['path'], frames=group)
            for i, group in enumerate(groups)]


def prepare_video(video_path, output_dir, config=SamplingConfig(), *, ffmpeg_path=None, ffprobe_path=None, should_stop=None):
    config.validate()
    video, destination = Path(video_path).resolve(), Path(output_dir).resolve()
    if not video.is_file():
        raise FileNotFoundError(video)
    tools = FFmpegTools(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path)
    metadata = tools.probe(video)
    if metadata.duration_sec > config.max_duration_sec:
        raise ValueError(f"Video exceeds {config.max_duration_sec:g}s limit; split it first")
    frame_dir = destination / 'frames'
    frame_dir.mkdir(parents=True, exist_ok=False)
    selection = (f"isnan(prev_selected_t)+gte(t-prev_selected_t,{config.interval_sec})"
                 f"+gt(scene,{config.scene_threshold})*gte(t-prev_selected_t,{config.min_scene_gap_sec})")
    command = [tools.ffmpeg, '-hide_banner', '-loglevel', 'info', '-i', str(video),
               '-map', '0:v:0', '-an', '-sn', '-vf',
               f"setpts=PTS-STARTPTS,select='{selection}',showinfo,scale=960:960:force_original_aspect_ratio=decrease",
               '-fps_mode', 'vfr', '-q:v', '3', str(frame_dir / 'frame_%06d.jpg')]
    result = run_cancellable(command, should_stop=should_stop, timeout=600)
    if result.returncode:
        details = result.stderr.decode(errors='replace').strip().splitlines()[-1:] or ['']
        raise UserFacingError(f'视频解码失败，请确认文件完整且为 FFmpeg 支持的格式。{details[0][-200:]}')
    timestamps = [float(t) for t in re.findall(r'\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:([\d.eE+-]+)',
                                               result.stderr.decode(errors='replace'))]
    files = sorted(frame_dir.glob('frame_*.jpg'))
    if not files or len(files) != len(timestamps):
        raise UserFacingError('视频解码结果异常（帧与时间戳数量不一致），请尝试重新封装视频后再审核。')
    frames = []
    for image_path, timestamp in zip(files, timestamps):
        if timestamp >= metadata.duration_sec:
            raise ValueError('Frame timestamp exceeds duration')
        # Preserve geometry, including portrait/ultrawide video, within Jev's image bounds.
        with Image.open(image_path) as source:
            normalized = ImageOps.pad(source.convert('RGB'),
                                      (max(280, source.width), max(280, source.height)), color='black')
            normalized.save(image_path, quality=90)
            signature = frame_signature(normalized)
        # '_sig' is used for per-window de-duplication in the pipeline and removed before inputs.json.
        frames.append({'time_sec': timestamp, 'path': image_path.as_posix(), '_sig': signature,
                       'sha256': hashlib.sha256(image_path.read_bytes()).hexdigest()})
    probe = subprocess.run([tools.ffprobe, '-v', 'error', '-select_streams', 'a',
                            '-show_entries', 'stream=index', '-of', 'json', str(video)],
                           capture_output=True, check=True, timeout=30, **_SUBPROCESS_KWARGS)
    payload = dict(schema_version=2, video_id=video.stem, video_path=video.as_posix(),
                   duration_sec=metadata.duration_sec, has_audio=bool(json.loads(probe.stdout)['streams']),
                   sampling=asdict(config), segments=group_frames(frames, metadata.duration_sec, config))
    public = dict(payload, segments=[dict(s, frames=[{k: v for k, v in f.items() if k != '_sig'} for f in s['frames']])
                                     for s in payload['segments']])
    (destination / 'segments.json').write_text(json.dumps(public, ensure_ascii=False, indent=2), encoding='utf-8')
    return payload
