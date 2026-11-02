from __future__ import annotations

import json
import math
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

# Prevent FFmpeg from inheriting and consuming Worker's command pipe.
_SUBPROCESS_KWARGS = (
    {"stdin": subprocess.DEVNULL, "creationflags": subprocess.CREATE_NO_WINDOW}
    if sys.platform == "win32"
    else {"stdin": subprocess.DEVNULL}
)



class FFmpegError(RuntimeError):
    pass


@dataclass(frozen=True)
class VideoMetadata:
    duration_sec: float
    width: int
    height: int


class FFmpegTools:
    """Resolve FFmpeg executables and inspect video metadata."""

    def __init__(
        self,
        *,
        ffmpeg_path: str | None,
        ffprobe_path: str | None,
    ) -> None:
        self.ffmpeg = self._resolve(ffmpeg_path, "ffmpeg")
        self.ffprobe = self._resolve(ffprobe_path, "ffprobe")

    @staticmethod
    def _resolve(configured: str | None, command: str) -> str:
        if configured:
            path = Path(configured)
            if not path.is_file():
                raise FFmpegError(f"Configured {command} does not exist: {path}")
            return str(path)
        discovered = shutil.which(command)
        if not discovered:
            raise FFmpegError(
                f"{command} was not found. Install FFmpeg and ensure {command} "
                "is on PATH, or set its path in the configuration file."
            )
        return discovered

    def probe(self, video_path: Path) -> VideoMetadata:
        command = [
            self.ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
            str(video_path),
        ]
        try:
            completed = subprocess.run(command, capture_output=True, check=False, timeout=30, **_SUBPROCESS_KWARGS)
        except subprocess.TimeoutExpired:
            raise FFmpegError("ffprobe 读取视频超时(30秒)，请检查视频文件是否可访问")
        if completed.returncode != 0:
            message = completed.stderr.decode("utf-8", errors="replace").strip()
            raise FFmpegError(f"ffprobe failed: {message}")
        try:
            payload = json.loads(completed.stdout.decode("utf-8"))
            stream = payload["streams"][0]
            duration = float(payload["format"]["duration"])
            width = int(stream["width"])
            height = int(stream["height"])
        except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise FFmpegError("ffprobe returned incomplete video metadata") from exc
        if not math.isfinite(duration) or duration <= 0:
            raise FFmpegError("video duration must be positive")
        return VideoMetadata(duration_sec=duration, width=width, height=height)

