from __future__ import annotations

import base64
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
from .errors import Cancelled, UserFacingError
from .paths import temp_root as audio_temp_root
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

_SUBPROCESS_KWARGS = (
    {"stdin": subprocess.DEVNULL, "creationflags": subprocess.CREATE_NO_WINDOW}
    if sys.platform == "win32"
    else {"stdin": subprocess.DEVNULL}
)


@dataclass(frozen=True)
class MimoASRSettings:
    base_url: str = "https://api.xiaomimimo.com/v1"
    model: str = "mimo-v2.5-asr"
    language: str = "auto"
    max_concurrency: int = 3
    max_chunk_duration_sec: float = 90.0
    timeout_sec: float = 180.0
    max_retries: int = 3
    ffmpeg_path: str | None = None

    def validate(self) -> None:
        if not self.base_url.strip():
            raise ValueError("小米ASR Base URL不能为空。")
        if not self.model.strip():
            raise ValueError("小米ASR模型名称不能为空。")
        if not self.language.strip():
            raise ValueError("小米ASR语言设置不能为空。")
        if not 1 <= self.max_concurrency <= 10:
            raise ValueError("小米ASR并发数量必须在1到10之间。")
        if self.max_chunk_duration_sec <= 0:
            raise ValueError("小米ASR单段音频时长必须大于0。")
        if self.timeout_sec <= 0:
            raise ValueError("小米ASR超时时间必须大于0。")
        if self.max_retries < 1:
            raise ValueError("小米ASR重试次数必须大于0。")


@dataclass(frozen=True)
class MimoBlockResult:
    segment_id: int
    start_sec: float
    end_sec: float
    text: str
    request_duration_sec: float
    audio_size_bytes: int
    chunks: tuple["MimoChunkResult", ...]


@dataclass(frozen=True)
class MimoChunkResult:
    start_sec: float
    end_sec: float
    text: str


MimoProgressCallback = Callable[[str, int, int], None]
MimoRequester = Callable[[Path], str]
AudioExtractor = Callable[[Path, float, float, Path], None]


def chat_completions_endpoint(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.endswith("/chat/completions"):
        return normalized
    return normalized + "/chat/completions"


def resolve_ffmpeg(configured: str | None) -> str:
    if configured:
        candidate = Path(configured)
        if not candidate.is_file():
            raise FileNotFoundError(f"配置的FFmpeg不存在：{candidate}")
        return str(candidate)
    discovered = shutil.which("ffmpeg")
    if not discovered:
        raise FileNotFoundError(
            "没有找到FFmpeg。请安装FFmpeg并加入PATH，或在配置中指定路径。"
        )
    return discovered


def extract_wav_segment(
    video_path: Path,
    start_sec: float,
    end_sec: float,
    output_path: Path,
    *,
    ffmpeg_path: str | None = None,
) -> None:
    duration = end_sec - start_sec
    if start_sec < 0 or duration <= 0:
        raise ValueError("音频片段时间范围无效。")
    command = [
        resolve_ffmpeg(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_sec:.6f}",
        "-i",
        str(video_path),
        "-t",
        f"{duration:.6f}",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            timeout=120,
            **_SUBPROCESS_KWARGS,
        )
    except subprocess.TimeoutExpired:
        raise UserFacingError("FFmpeg提取临时音频超时(120秒)")
    if completed.returncode != 0:
        details = completed.stderr.decode("utf-8", errors="replace").strip().splitlines()[-1:] or [""]
        raise UserFacingError(f"FFmpeg提取临时音频失败：{details[0][-200:]}")
    if not output_path.is_file() or output_path.stat().st_size <= 44:
        raise UserFacingError("没有从视频中提取到有效音频。")


def extract_chat_text(payload: Mapping[str, Any]) -> str:
    try:
        message = payload["choices"][0]["message"]
        content = message["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("小米ASR响应缺少 choices[0].message.content。") from exc
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if not isinstance(item, Mapping):
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
        if parts:
            return "\n".join(parts)
    raise ValueError("小米ASR响应中的文字格式无法识别。")


class MimoHTTPError(UserFacingError):
    """Cloud ASR HTTP failure; the response body is never included (it can echo credentials)."""

    def __init__(self, status: int):
        hint = {401: "请检查 ASR API Key", 403: "请检查 ASR API Key 的权限", 404: "请检查 ASR 服务地址与模型名称",
                413: "音频过大", 429: "请求过于频繁，可降低并发数"}.get(status, "服务暂时不可用" if status >= 500 else "请检查 ASR 配置")
        super().__init__(f"云端语音识别失败：HTTP {status}（{hint}）")
        self.status = status


def _retryable(error: Exception) -> bool:
    if isinstance(error, MimoHTTPError):
        return error.status == 429 or error.status >= 500
    # Malformed responses and local configuration problems will not fix themselves.
    return not isinstance(error, (ValueError, FileNotFoundError, UserFacingError))


def request_mimo_asr(
    audio_path: Path,
    *,
    settings: MimoASRSettings,
    api_key: str,
) -> str:
    try:
        import httpx
    except ImportError as exc:
        raise UserFacingError(
            "缺少HTTP依赖，请执行：python -m pip install httpx"
        ) from exc
    audio_base64 = base64.b64encode(audio_path.read_bytes()).decode("ascii")
    payload = {
        "model": settings.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": f"data:audio/wav;base64,{audio_base64}"
                        },
                    }
                ],
            }
        ],
        "asr_options": {"language": settings.language},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    response = httpx.post(
        chat_completions_endpoint(settings.base_url),
        headers=headers,
        json=payload,
        timeout=settings.timeout_sec,
    )
    if response.is_error:
        raise MimoHTTPError(response.status_code)
    try:
        data = response.json()
    except ValueError as exc:
        raise UserFacingError("云端语音识别返回了无效 JSON。") from exc
    if not isinstance(data, Mapping):
        raise UserFacingError("云端语音识别响应格式异常。")
    return extract_chat_text(data)


def _request_with_retries(
    audio_path: Path,
    *,
    settings: MimoASRSettings,
    requester: MimoRequester,
) -> str:
    last_error: Exception | None = None
    for attempt in range(1, settings.max_retries + 1):
        try:
            return requester(audio_path)
        except Exception as exc:
            last_error = exc
            if not _retryable(exc):
                break
            if attempt < settings.max_retries:
                time.sleep(
                    min(8.0, 2 ** (attempt - 1)) + random.random() * 0.25
                )
    assert last_error is not None
    raise last_error


_WORD = re.compile(r"\w")


def clean_asr_text(text: str) -> str:
    """Drop outputs that carry no words (empty, punctuation only)."""
    text = (text or "").strip()
    return text if _WORD.search(text) else ""


def extract_full_audio(video_path: Path, output_path: Path, *, ffmpeg_path: str | None = None, should_stop=None) -> None:
    """Decode the whole audio track once (16 kHz mono PCM); chunks are then sliced in memory."""
    command = [resolve_ffmpeg(ffmpeg_path), "-hide_banner", "-loglevel", "error", "-i", str(video_path),
               "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", str(output_path)]
    from .media import run_cancellable
    try:
        completed = run_cancellable(command, should_stop=should_stop, timeout=300)
    except subprocess.TimeoutExpired:
        raise UserFacingError("FFmpeg提取音频超时(300秒)")
    if completed.returncode != 0 or not output_path.is_file() or output_path.stat().st_size <= 44:
        details = completed.stderr.decode("utf-8", errors="replace").strip().splitlines()[-1:] or [""]
        raise UserFacingError(f"FFmpeg提取音频失败：{details[0][-200:]}")


def detect_silences(audio_path: Path, *, noise_db: float, min_silence_sec: float,
                    ffmpeg_path: str | None = None) -> list[tuple[float, float]]:
    """Silent intervals from FFmpeg's silencedetect filter (signal level, no model)."""
    command = [resolve_ffmpeg(ffmpeg_path), "-hide_banner", "-nostats", "-i", str(audio_path),
               "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_sec}", "-f", "null", "-"]
    completed = subprocess.run(command, capture_output=True, check=False, timeout=120, **_SUBPROCESS_KWARGS)
    if completed.returncode != 0:
        raise UserFacingError("FFmpeg静音检测失败。")
    log = completed.stderr.decode("utf-8", errors="replace")
    starts = [float(x) for x in re.findall(r"silence_start:\s*(-?[\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end:\s*(-?[\d.]+)", log)]
    silences = []
    for index, begin in enumerate(starts):
        finish = ends[index] if index < len(ends) else float("inf")
        silences.append((max(0.0, begin), finish))
    return silences


def plan_speech_chunks(duration: float, silences: Sequence[tuple[float, float]],
                       quiet_dips: Sequence[tuple[float, float]] = (), *, max_sec: float = 8.0,
                       merge_gap_sec: float = 1.0, pad_sec: float = 0.15,
                       min_speech_sec: float = 0.1) -> list[dict[str, Any]]:
    """Partition [0, duration] into speech chunks (cut at pauses, at most max_sec) and silent gaps.

    Silent gaps are marked skip=True and are never uploaded. Continuous sound longer than max_sec is
    cut at the quietest dips found with a looser threshold, and only as a last resort at a fixed length.
    """
    if duration <= 0 or max_sec <= 0:
        raise ValueError("Invalid speech chunk limits")
    # 1. speech = complement of silence
    speech: list[list[float]] = []
    cursor = 0.0
    for begin, finish in sorted(silences):
        begin, finish = max(0.0, min(begin, duration)), max(0.0, min(finish, duration))
        if begin - cursor >= min_speech_sec:
            speech.append([cursor, begin])
        cursor = max(cursor, finish)
    if duration - cursor >= min_speech_sec:
        speech.append([cursor, duration])
    # 2. pad a little into the surrounding silence so word edges are not clipped
    original = [tuple(item) for item in speech]
    for index, (begin, finish) in enumerate(original):
        low = 0.0 if index == 0 else (original[index - 1][1] + begin) / 2
        high = duration if index + 1 == len(original) else (finish + original[index + 1][0]) / 2
        speech[index] = [max(low, begin - pad_sec), min(high, finish + pad_sec)]
    # 3. split continuous sound at quiet dips, then at fixed length
    dips = sorted((a + b) / 2 for a, b in quiet_dips)
    pieces: list[list[float]] = []
    for begin, finish in speech:
        while finish - begin > max_sec:
            limit = begin + max_sec
            candidates = [d for d in dips if begin + 1.0 <= d <= limit]
            cut = candidates[-1] if candidates else limit
            pieces.append([begin, cut])
            begin = cut
        pieces.append([begin, finish])
    # 4. merge neighbours separated by short pauses while the chunk stays within max_sec
    chunks: list[list[float]] = []
    for begin, finish in pieces:
        if chunks and begin - chunks[-1][1] <= merge_gap_sec and finish - chunks[-1][0] <= max_sec:
            chunks[-1][1] = finish
        else:
            chunks.append([begin, finish])
    # 5. full partition with skipped silent gaps
    blocks: list[dict[str, Any]] = []
    cursor = 0.0
    for begin, finish in chunks:
        if begin - cursor > 1e-6:
            blocks.append({"start_sec": cursor, "end_sec": begin, "skip": True})
        blocks.append({"start_sec": begin, "end_sec": finish, "skip": False})
        cursor = finish
    if duration - cursor > 1e-6:
        blocks.append({"start_sec": cursor, "end_sec": duration, "skip": True})
    for index, block in enumerate(blocks, start=1):
        block["segment_id"] = index
        block["start_sec"] = round(block["start_sec"], 3)
        block["end_sec"] = round(block["end_sec"], 3)
    return blocks


class WavSlicer:
    """Audio extractor that slices one decoded 16-bit WAV in memory (no FFmpeg call per chunk)."""

    def __init__(self, wav_path: Path):
        import wave
        with wave.open(str(wav_path), "rb") as source:
            self.params = source.getparams()
            self.frames = source.readframes(source.getnframes())
        self.rate = self.params.framerate
        self.width = self.params.sampwidth * self.params.nchannels

    def __call__(self, _video: Path, start_sec: float, end_sec: float, output_path: Path) -> None:
        import wave
        first = max(0, int(round(start_sec * self.rate)))
        last = min(len(self.frames) // self.width, int(round(end_sec * self.rate)))
        if last <= first:
            raise UserFacingError("没有从视频中提取到有效音频。")
        with wave.open(str(output_path), "wb") as target:
            target.setparams(self.params)
            target.writeframes(self.frames[first * self.width:last * self.width])


def transcribe_blocks_with_mimo(
    video_path: str | Path,
    blocks: Sequence[Mapping[str, Any]],
    *,
    settings: MimoASRSettings,
    api_key: str,
    progress_callback: MimoProgressCallback | None = None,
    requester: MimoRequester | None = None,
    audio_extractor: AudioExtractor | None = None,
    limiter: Any = None,
    should_stop: Callable[[], bool] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Transcribe each block with the cloud ASR.

    Blocks marked ``skip`` (silence) are not uploaded. A block that still fails after retries is
    reported with ``asr_status: "failed"`` instead of aborting the video; only when every uploaded
    block fails is the first error raised. ``limiter`` (optional) caps requests across all videos.
    """
    settings.validate()
    if not api_key.strip():
        raise ValueError("小米ASR API Key不能为空。")
    video = Path(video_path)
    if not video.is_file():
        raise FileNotFoundError(f"视频文件不存在：{video}")
    if not blocks:
        raise ValueError("没有可转写的音频片段。")
    active = [block for block in blocks if not block.get("skip")]
    total = len(active)

    actual_requester = requester or (
        lambda audio_path: request_mimo_asr(audio_path, settings=settings, api_key=api_key)
    )
    actual_extractor = audio_extractor or (
        lambda source, start, end, target: extract_wav_segment(
            source, start, end, target, ffmpeg_path=settings.ffmpeg_path,
        )
    )
    progress_lock = threading.Lock()
    completed_count = 0

    def report(message: str) -> None:
        nonlocal completed_count
        if progress_callback is None:
            return
        with progress_lock:
            completed_count += 1
            progress_callback(message, completed_count, total)

    def request(audio_path: Path) -> str:
        if should_stop and should_stop():
            raise Cancelled()
        if limiter is None:
            return _request_with_retries(audio_path, settings=settings, requester=actual_requester)
        with limiter.slot():
            return _request_with_retries(audio_path, settings=settings, requester=actual_requester)

    def process_block(block: Mapping[str, Any], temp_root: Path) -> MimoBlockResult:
        segment_id = int(block["segment_id"])
        start_sec = float(block["start_sec"])
        end_sec = float(block["end_sec"])
        request_started = time.perf_counter()
        chunk_ranges: list[tuple[float, float]] = []
        chunk_start = start_sec
        while chunk_start < end_sec:
            chunk_end = min(end_sec, chunk_start + settings.max_chunk_duration_sec)
            chunk_ranges.append((chunk_start, chunk_end))
            chunk_start = chunk_end
        chunks: list[MimoChunkResult] = []
        audio_size = 0
        for chunk_index, (chunk_start, chunk_end) in enumerate(chunk_ranges, start=1):
            if len(chunk_ranges) == 1:
                filename = f"block_{segment_id:04d}.wav"
            else:
                filename = f"block_{segment_id:04d}_chunk_{chunk_index:03d}.wav"
            audio_path = temp_root / filename
            try:
                actual_extractor(video, chunk_start, chunk_end, audio_path)
                audio_size += audio_path.stat().st_size
                text = clean_asr_text(request(audio_path))
                chunks.append(MimoChunkResult(start_sec=chunk_start, end_sec=chunk_end, text=text))
            finally:
                try:
                    audio_path.unlink(missing_ok=True)
                except OSError:
                    pass
        return MimoBlockResult(
            segment_id=segment_id, start_sec=start_sec, end_sec=end_sec,
            text="\n".join(chunk.text for chunk in chunks if chunk.text),
            request_duration_sec=time.perf_counter() - request_started,
            audio_size_bytes=audio_size, chunks=tuple(chunks),
        )

    results: dict[int, MimoBlockResult] = {}
    errors: dict[int, Exception] = {}
    with tempfile.TemporaryDirectory(prefix="short-video-mimo-asr-", dir=audio_temp_root()) as temp:
        temp_root = Path(temp)
        if active:
            with ThreadPoolExecutor(max_workers=min(settings.max_concurrency, total),
                                    thread_name_prefix="mimo-asr") as executor:
                futures: dict[Future[MimoBlockResult], int] = {
                    executor.submit(process_block, block, temp_root): int(block["segment_id"]) for block in active
                }
                for future in as_completed(futures):
                    segment_id = futures[future]
                    try:
                        results[segment_id] = future.result()
                    except Exception as exc:
                        errors[segment_id] = exc
                    report(f"第{segment_id}段云端语音识别完成")
    if should_stop and should_stop():
        raise Cancelled()
    if active and not results:
        raise next(iter(errors.values()))

    block_transcripts: list[dict[str, Any]] = []
    request_durations: list[float] = []
    uploaded_bytes = 0
    audio_chunk_request_count = 0
    for block in blocks:
        segment_id = int(block["segment_id"])
        base = {
            "segment_id": segment_id,
            "start_sec": round(float(block["start_sec"]), 3),
            "end_sec": round(float(block["end_sec"]), 3),
            "screenshot_path": block.get("screenshot_path"),
        }
        item = results.get(segment_id)
        if item is None:
            status = "silent" if block.get("skip") else "failed"
            entry = {**base, "speech_text": "", "utterances": [], "asr_status": status,
                     "cloud_request_duration_sec": 0.0, "cloud_audio_chunk_count": 0}
            if status == "failed":
                entry["asr_error"] = type(errors[segment_id]).__name__
            block_transcripts.append(entry)
            continue
        request_durations.append(item.request_duration_sec)
        uploaded_bytes += item.audio_size_bytes
        audio_chunk_request_count += len(item.chunks)
        block_transcripts.append({
            **base,
            "speech_text": item.text,
            "utterances": [
                {"start_sec": round(chunk.start_sec, 3), "end_sec": round(chunk.end_sec, 3), "text": chunk.text}
                for chunk in item.chunks if chunk.text
            ],
            "asr_status": "transcribed",
            "cloud_request_duration_sec": round(item.request_duration_sec, 3),
            "cloud_audio_chunk_count": len(item.chunks),
        })
    statistics = {
        "block_request_count": total,
        "skipped_silent_block_count": len(blocks) - total,
        "failed_block_count": len(errors),
        "audio_chunk_request_count": audio_chunk_request_count,
        "max_chunk_duration_sec": settings.max_chunk_duration_sec,
        "max_concurrency": min(settings.max_concurrency, max(total, 1)),
        "uploaded_audio_bytes": uploaded_bytes,
        "average_block_request_duration_sec": round(sum(request_durations) / len(request_durations), 3) if request_durations else 0.0,
        "slowest_block_request_duration_sec": round(max(request_durations), 3) if request_durations else 0.0,
    }
    return block_transcripts, statistics


def resolve_mimo_api_key(
    configured_env: str,
    explicit_api_key: str | None = None,
) -> str:
    if explicit_api_key and explicit_api_key.strip():
        return explicit_api_key.strip()
    names = [configured_env, "MIMO_API_KEY", "LLM_API_KEY"]
    for name in dict.fromkeys(item for item in names if item):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise ValueError(
        "没有找到小米ASR API Key。请在界面输入，或设置 MIMO_API_KEY。"
    )
