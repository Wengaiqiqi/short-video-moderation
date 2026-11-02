from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field, fields
from .paths import cache_root
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol, Sequence

from .errors import UserFacingError
from .cloud_asr import (
    AudioExtractor,
    MimoASRSettings,
    MimoRequester,
    resolve_mimo_api_key,
    transcribe_blocks_with_mimo,
)


@dataclass(frozen=True)
class TranscriptionConfig:
    engine: str = "faster-whisper"
    model: str = "small"
    language: str | None = "zh"
    device: str = "cpu"
    compute_type: str = "int8"
    beam_size: int = 1
    vad_filter: bool = True
    model_download_root: str | None = field(default_factory=lambda: str(cache_root() / "faster-whisper"))
    initial_prompt: str | None = None
    hotwords: str | None = None
    mimo_base_url: str = "https://api.xiaomimimo.com/v1"
    mimo_model: str = "mimo-v2.5-asr"
    mimo_api_key_env: str = "MIMO_API_KEY"
    mimo_language: str = "auto"
    mimo_max_concurrency: int = 3
    mimo_max_chunk_duration_sec: float = 90.0
    mimo_timeout_sec: float = 180.0
    mimo_max_retries: int = 3
    ffmpeg_path: str | None = None

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "TranscriptionConfig":
        allowed = {field.name for field in fields(cls)}
        unknown = sorted(set(data) - allowed)
        if unknown:
            raise ValueError(
                f"Unknown transcription configuration keys: {', '.join(unknown)}"
            )
        config = cls(**dict(data))
        config.validate()
        return config

    @classmethod
    def from_file(cls, path: str | Path) -> "TranscriptionConfig":
        config_path = Path(path)
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid transcription configuration: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("Transcription configuration root must be an object")
        return cls.from_mapping(data)

    def validate(self) -> None:
        if self.engine not in {"faster-whisper", "mimo-cloud"}:
            raise ValueError(
                "transcription engine must be faster-whisper or mimo-cloud"
            )
        if not self.model.strip():
            raise ValueError("transcription model must not be empty")
        if self.language is not None and not self.language.strip():
            raise ValueError("language must be null or a non-empty code")
        if self.device not in {"cpu", "cuda", "auto"}:
            raise ValueError("device must be cpu, cuda, or auto")
        if self.beam_size < 1:
            raise ValueError("beam_size must be positive")
        MimoASRSettings(
            base_url=self.mimo_base_url,
            model=self.mimo_model,
            language=self.mimo_language,
            max_concurrency=self.mimo_max_concurrency,
            max_chunk_duration_sec=self.mimo_max_chunk_duration_sec,
            timeout_sec=self.mimo_timeout_sec,
            max_retries=self.mimo_max_retries,
            ffmpeg_path=self.ffmpeg_path,
        ).validate()
        if not self.mimo_api_key_env.strip():
            raise ValueError("mimo_api_key_env must not be empty")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SpeechUtterance:
    start_sec: float
    end_sec: float
    text: str
    avg_logprob: float | None = None
    no_speech_prob: float | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "start_sec": round(self.start_sec, 3),
            "end_sec": round(self.end_sec, 3),
            "text": self.text,
        }
        if self.avg_logprob is not None:
            payload["avg_logprob"] = round(self.avg_logprob, 4)
        if self.no_speech_prob is not None:
            payload["no_speech_prob"] = round(self.no_speech_prob, 4)
        return payload


class WhisperModelLike(Protocol):
    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Iterable[Any], Any]:
        ...


ModelFactory = Callable[[TranscriptionConfig], WhisperModelLike]
ProgressCallback = Callable[[str, float | None], None]


def probe_media_duration(video_path: str | Path) -> float | None:
    try:
        import av

        with av.open(str(video_path)) as container:
            if container.duration is None:
                return None
            return float(container.duration) / float(av.time_base)
    except Exception:
        return None


def validate_video_and_block_duration(
    video_duration_sec: float | None,
    block_duration_sec: float,
) -> None:
    if video_duration_sec is None:
        return
    tolerance = max(2.0, block_duration_sec * 0.01)
    if abs(video_duration_sec - block_duration_sec) > tolerance:
        raise ValueError(
            "视频时长与音频时间段不匹配："
            f"视频约 {video_duration_sec:.3f} 秒，"
            f"音频时间轴约 {block_duration_sec:.3f} 秒。"
            "请选择该视频对应的完整 result.json，不能将测试片段与完整时间轴混用。"
        )


def _default_model_factory(config: TranscriptionConfig) -> WhisperModelLike:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise UserFacingError(
            "缺少语音识别依赖，请执行：python -m pip install faster-whisper"
        ) from exc
    download_root = (
        str(Path(config.model_download_root).resolve())
        if config.model_download_root
        else None
    )
    return WhisperModel(
        config.model,
        device=config.device,
        compute_type=config.compute_type,
        download_root=download_root,
    )


def format_timestamp(seconds: float) -> str:
    total_milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(total_milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"


def load_block_intervals(result_path: str | Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = Path(result_path)
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid audio interval JSON: {exc}") from exc
    if not isinstance(result, dict) or not isinstance(result.get("segments"), list):
        raise ValueError("Audio interval JSON must contain a segments array")
    blocks: list[dict[str, Any]] = []
    previous_end: float | None = None
    for index, raw_block in enumerate(result["segments"], start=1):
        if not isinstance(raw_block, dict):
            raise ValueError(f"block {index} must be an object")
        try:
            start = float(raw_block["start_sec"])
            end = float(raw_block["end_sec"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"block {index} has invalid start/end time") from exc
        if start < 0 or end <= start:
            raise ValueError(f"block {index} has an invalid time interval")
        if previous_end is not None and start < previous_end - 0.01:
            raise ValueError("Audio block intervals must not overlap")
        block = dict(raw_block)
        block["segment_id"] = int(raw_block.get("segment_id", index))
        block["start_sec"] = start
        block["end_sec"] = end
        blocks.append(block)
        previous_end = end
    if not blocks:
        raise ValueError("Audio interval JSON contains no segments")
    return result, blocks


def _overlap_seconds(
    utterance: SpeechUtterance,
    block: Mapping[str, Any],
) -> float:
    return max(
        0.0,
        min(utterance.end_sec, float(block["end_sec"]))
        - max(utterance.start_sec, float(block["start_sec"])),
    )


def assign_utterances_to_blocks(
    blocks: Sequence[Mapping[str, Any]],
    utterances: Sequence[SpeechUtterance],
) -> list[list[SpeechUtterance]]:
    assignments: list[list[SpeechUtterance]] = [[] for _ in blocks]
    if not blocks:
        return assignments
    for utterance in utterances:
        overlaps = [_overlap_seconds(utterance, block) for block in blocks]
        best_index = max(range(len(blocks)), key=overlaps.__getitem__)
        if overlaps[best_index] <= 0:
            midpoint = (utterance.start_sec + utterance.end_sec) / 2.0
            best_index = min(
                range(len(blocks)),
                key=lambda index: min(
                    abs(midpoint - float(blocks[index]["start_sec"])),
                    abs(midpoint - float(blocks[index]["end_sec"])),
                ),
            )
        assignments[best_index].append(utterance)
    return assignments


def build_block_transcripts(
    blocks: Sequence[Mapping[str, Any]],
    utterances: Sequence[SpeechUtterance],
) -> list[dict[str, Any]]:
    assignments = assign_utterances_to_blocks(blocks, utterances)
    output: list[dict[str, Any]] = []
    for block, block_utterances in zip(blocks, assignments, strict=True):
        output.append(
            {
                "segment_id": int(block["segment_id"]),
                "start_sec": round(float(block["start_sec"]), 3),
                "end_sec": round(float(block["end_sec"]), 3),
                "screenshot_path": block.get("screenshot_path"),
                "speech_text": "\n".join(
                    utterance.text for utterance in block_utterances
                ),
                "utterances": [
                    utterance.to_dict() for utterance in block_utterances
                ],
            }
        )
    return output


def render_block_transcripts_markdown(
    video_id: str,
    blocks: Sequence[Mapping[str, Any]],
) -> str:
    lines = [
        f"# {video_id} 分段语音文字",
        "",
        "> 保留视频中的全部可识别讲话，不区分说话人，不清理口头语。",
        "",
    ]
    for block in blocks:
        segment_id = int(block["segment_id"])
        lines.extend(
            [
                f"## 第 {segment_id} 段",
                "",
                (
                    f"**时间范围**： {format_timestamp(float(block['start_sec']))}"
                    f" ～ {format_timestamp(float(block['end_sec']))}"
                ),
                "",
            ]
        )
        utterances = block.get("utterances", [])
        if not utterances:
            lines.extend(["（该片段时间段内没有识别到讲话）", ""])
            continue
        for utterance in utterances:
            lines.extend(
                [
                    (
                        f"[{format_timestamp(float(utterance['start_sec']))}"
                        f" ～ {format_timestamp(float(utterance['end_sec']))}]"
                    ),
                    "",
                    str(utterance["text"]),
                    "",
                ]
            )
    return "\n".join(lines).rstrip() + "\n"


def transcribe_video_blocks(
    video_path: str | Path,
    result_path: str | Path,
    *,
    config: TranscriptionConfig,
    output_dir: str | Path | None = None,
    progress_callback: ProgressCallback | None = None,
    model_factory: ModelFactory | None = None,
    api_key: str | None = None,
    cloud_requester: MimoRequester | None = None,
    audio_extractor: AudioExtractor | None = None,
    cloud_limiter: Any = None,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    video = Path(video_path)
    if not video.is_file():
        raise FileNotFoundError(f"Video file does not exist: {video}")
    source_result, blocks = load_block_intervals(result_path)
    video_duration = probe_media_duration(video)
    block_duration = float(blocks[-1]["end_sec"])
    validate_video_and_block_duration(video_duration, block_duration)
    destination = (
        Path(output_dir)
        if output_dir is not None
        else Path(result_path).resolve().parent
    )
    destination.mkdir(parents=True, exist_ok=True)

    def report(message: str, progress: float | None) -> None:
        if progress_callback is not None:
            progress_callback(message, progress)

    if config.engine == "mimo-cloud":
        report("正在准备按音频片段提取临时音频", 0.02)
        resolved_api_key = resolve_mimo_api_key(
            config.mimo_api_key_env,
            api_key,
        )
        settings = MimoASRSettings(
            base_url=config.mimo_base_url,
            model=config.mimo_model,
            language=config.mimo_language,
            max_concurrency=config.mimo_max_concurrency,
            max_chunk_duration_sec=config.mimo_max_chunk_duration_sec,
            timeout_sec=config.mimo_timeout_sec,
            max_retries=config.mimo_max_retries,
            ffmpeg_path=config.ffmpeg_path,
        )
        block_transcripts, cloud_statistics = transcribe_blocks_with_mimo(
            video,
            blocks,
            settings=settings,
            api_key=resolved_api_key,
            progress_callback=lambda message, completed, total: report(
                message,
                min(0.94, 0.04 + completed / max(total, 1) * 0.90),
            ),
            requester=cloud_requester,
            audio_extractor=audio_extractor,
            limiter=cloud_limiter,
        )
        utterance_count = sum(
            len(block.get("utterances", [])) for block in block_transcripts
        )
        payload: dict[str, Any] = {
            "video_id": str(source_result.get("video_id", video.stem)),
            "video_path": video.resolve().as_posix(),
            "video_duration_sec": (
                round(video_duration, 3)
                if video_duration is not None
                else None
            ),
            "intervals_path": Path(result_path).resolve().as_posix(),
            "processing_duration_sec": round(
                time.perf_counter() - started_at, 3
            ),
            "transcription": {
                "engine": "mimo-cloud",
                "model": config.mimo_model,
                "language": config.mimo_language,
                "language_probability": None,
                "speaker_diarization": False,
                "oral_filler_cleanup": False,
                "audio_files_retained": False,
                "utterance_count": utterance_count,
                "cloud_statistics": cloud_statistics,
            },
            "segments": block_transcripts,
            "config": config.to_dict(),
        }
        transcript_path = destination / "transcript.json"
        markdown_path = destination / "分段语音文字.md"
        payload["artifacts"] = {
            "transcript_json": transcript_path.resolve().as_posix(),
            "block_transcript_markdown": markdown_path.resolve().as_posix(),
        }
        transcript_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        markdown_path.write_text(
            render_block_transcripts_markdown(
                payload["video_id"],
                block_transcripts,
            ),
            encoding="utf-8",
        )
        report("小米云端语音文字处理完成，临时音频已删除", 1.0)
        return payload

    report("正在加载本地语音识别模型", 0.02)
    factory = model_factory or _default_model_factory
    model = factory(config)
    report("正在识别整段视频中的全部讲话", 0.05)
    segments, info = model.transcribe(
        str(video.resolve()),
        language=config.language,
        task="transcribe",
        beam_size=config.beam_size,
        vad_filter=config.vad_filter,
        condition_on_previous_text=True,
        word_timestamps=False,
        initial_prompt=config.initial_prompt,
        hotwords=config.hotwords,
    )
    duration = max(video_duration or block_duration, 1.0)
    utterances: list[SpeechUtterance] = []
    for segment in segments:
        text = str(segment.text).strip()
        if not text:
            continue
        utterance = SpeechUtterance(
            start_sec=float(segment.start),
            end_sec=float(segment.end),
            text=text,
            avg_logprob=(
                float(segment.avg_logprob)
                if getattr(segment, "avg_logprob", None) is not None
                else None
            ),
            no_speech_prob=(
                float(segment.no_speech_prob)
                if getattr(segment, "no_speech_prob", None) is not None
                else None
            ),
        )
        utterances.append(utterance)
        report(
            f"已识别到 {format_timestamp(utterance.end_sec)}",
            min(0.92, 0.05 + 0.87 * utterance.end_sec / duration),
        )

    report("正在按音频时间区间整理文字", 0.94)
    block_transcripts = build_block_transcripts(blocks, utterances)
    detected_language = getattr(info, "language", config.language)
    language_probability = getattr(info, "language_probability", None)
    payload: dict[str, Any] = {
        "video_id": str(source_result.get("video_id", video.stem)),
        "video_path": video.resolve().as_posix(),
        "video_duration_sec": (
            round(video_duration, 3)
            if video_duration is not None
            else None
        ),
        "intervals_path": Path(result_path).resolve().as_posix(),
        "processing_duration_sec": round(time.perf_counter() - started_at, 3),
        "transcription": {
            "engine": "faster-whisper",
            "model": config.model,
            "language": detected_language,
            "language_probability": (
                round(float(language_probability), 4)
                if language_probability is not None
                else None
            ),
            "speaker_diarization": False,
            "oral_filler_cleanup": False,
            "audio_files_retained": False,
            "utterance_count": len(utterances),
        },
        "segments": block_transcripts,
        "config": config.to_dict(),
    }
    transcript_path = destination / "transcript.json"
    markdown_path = destination / "分段语音文字.md"
    payload["artifacts"] = {
        "transcript_json": transcript_path.resolve().as_posix(),
        "block_transcript_markdown": markdown_path.resolve().as_posix(),
    }
    transcript_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    markdown_path.write_text(
        render_block_transcripts_markdown(payload["video_id"], block_transcripts),
        encoding="utf-8",
    )
    report("语音文字处理完成", 1.0)
    return payload
