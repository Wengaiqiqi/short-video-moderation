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

from .media import FFmpegTools, _SUBPROCESS_KWARGS


@dataclass(frozen=True)
class SamplingConfig:
    interval_sec: float = 0.5
    scene_threshold: float = 0.25
    segment_sec: float = 8.0
    min_scene_gap_sec: float = 0.15
    max_frames_per_segment: int = 16
    max_duration_sec: float = 600.0

    def validate(self):
        for value in (self.interval_sec, self.segment_sec, self.min_scene_gap_sec, self.max_duration_sec):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Sampling durations must be finite and positive")
        if not 0 < self.scene_threshold <= 1 or not 1 <= self.max_frames_per_segment <= 32:
            raise ValueError("Invalid scene threshold or frame batch size")
        if self.min_scene_gap_sec > self.interval_sec:
            raise ValueError("Scene gap cannot exceed periodic interval")


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


def prepare_video(video_path, output_dir, config=SamplingConfig(), *, ffmpeg_path=None, ffprobe_path=None):
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
    result = subprocess.run(command, capture_output=True, timeout=600, **_SUBPROCESS_KWARGS)
    if result.returncode:
        raise RuntimeError('Video decoding failed: ' + result.stderr.decode(errors='replace')[-1000:])
    timestamps = [float(t) for t in re.findall(r'\bn:\s*\d+\s+pts:\s*\S+\s+pts_time:([\d.eE+-]+)',
                                               result.stderr.decode(errors='replace'))]
    files = sorted(frame_dir.glob('frame_*.jpg'))
    if not files or len(files) != len(timestamps):
        raise RuntimeError('Decoded frame/timestamp count mismatch')
    frames = []
    for image_path, timestamp in zip(files, timestamps):
        if timestamp >= metadata.duration_sec:
            raise ValueError('Frame timestamp exceeds duration')
        # Preserve geometry, including portrait/ultrawide video, within Jev's image bounds.
        with Image.open(image_path) as source:
            normalized = ImageOps.pad(source.convert('RGB'),
                                      (max(280, source.width), max(280, source.height)), color='black')
            normalized.save(image_path, quality=90)
        frames.append({'time_sec': timestamp, 'path': image_path.as_posix(),
                       'sha256': hashlib.sha256(image_path.read_bytes()).hexdigest()})
    probe = subprocess.run([tools.ffprobe, '-v', 'error', '-select_streams', 'a',
                            '-show_entries', 'stream=index', '-of', 'json', str(video)],
                           capture_output=True, check=True, timeout=30, **_SUBPROCESS_KWARGS)
    payload = dict(schema_version=2, video_id=video.stem, video_path=video.as_posix(),
                   duration_sec=metadata.duration_sec, has_audio=bool(json.loads(probe.stdout)['streams']),
                   sampling=asdict(config), segments=group_frames(frames, metadata.duration_sec, config))
    (destination / 'segments.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return payload
