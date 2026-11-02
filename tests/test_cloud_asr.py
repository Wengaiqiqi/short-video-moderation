import json
import tempfile
import unittest
from pathlib import Path

from short_video_moderation.cloud_asr import (
    MimoASRSettings,
    chat_completions_endpoint,
    extract_chat_text,
    transcribe_blocks_with_mimo,
)
from short_video_moderation.transcription import (
    TranscriptionConfig,
    transcribe_video_blocks,
)


class MimoASRTests(unittest.TestCase):
    def test_builds_official_chat_completions_endpoint(self) -> None:
        self.assertEqual(
            chat_completions_endpoint("https://api.xiaomimimo.com/v1"),
            "https://api.xiaomimimo.com/v1/chat/completions",
        )
        self.assertEqual(
            chat_completions_endpoint(
                "https://api.xiaomimimo.com/v1/chat/completions"
            ),
            "https://api.xiaomimimo.com/v1/chat/completions",
        )

    def test_extracts_text_from_chat_completion(self) -> None:
        self.assertEqual(
            extract_chat_text(
                {"choices": [{"message": {"content": "视频转写。"}}]}
            ),
            "视频转写。",
        )
        self.assertEqual(
            extract_chat_text(
                {
                    "choices": [
                        {
                            "message": {
                                "content": [
                                    {"type": "text", "text": "第一句。"},
                                    {"type": "text", "text": "第二句。"},
                                ]
                            }
                        }
                    ]
                }
            ),
            "第一句。\n第二句。",
        )

    def test_parallel_block_transcription_removes_temporary_audio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "lesson.mp4"
            video.write_bytes(b"fake-video")
            extracted_paths: list[Path] = []

            def extractor(
                _: Path,
                __: float,
                ___: float,
                output: Path,
            ) -> None:
                output.write_bytes(b"R" * 100)
                extracted_paths.append(output)

            def requester(audio_path: Path) -> str:
                return f"{audio_path.stem}的讲话"

            blocks = [
                {"segment_id": 1, "start_sec": 0.0, "end_sec": 10.0},
                {"segment_id": 2, "start_sec": 10.0, "end_sec": 20.0},
            ]
            transcripts, statistics = transcribe_blocks_with_mimo(
                video,
                blocks,
                settings=MimoASRSettings(max_concurrency=2),
                api_key="test-key",
                requester=requester,
                audio_extractor=extractor,
            )
            self.assertEqual(len(transcripts), 2)
            self.assertEqual(
                transcripts[0]["speech_text"],
                "block_0001的讲话",
            )
            self.assertEqual(statistics["block_request_count"], 2)
            self.assertTrue(extracted_paths)
            self.assertTrue(all(not path.exists() for path in extracted_paths))

    def test_long_block_is_split_and_merged_in_time_order(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "lesson.mp4"
            video.write_bytes(b"fake-video")
            extracted_ranges: list[tuple[float, float]] = []

            def extractor(
                _: Path,
                start_sec: float,
                end_sec: float,
                output: Path,
            ) -> None:
                extracted_ranges.append((start_sec, end_sec))
                output.write_bytes(b"R" * 100)

            transcripts, statistics = transcribe_blocks_with_mimo(
                video,
                [{"segment_id": 1, "start_sec": 5.0, "end_sec": 30.0}],
                settings=MimoASRSettings(
                    max_concurrency=1,
                    max_chunk_duration_sec=10.0,
                ),
                api_key="test-key",
                requester=lambda path: path.stem,
                audio_extractor=extractor,
            )

            self.assertEqual(
                extracted_ranges,
                [(5.0, 15.0), (15.0, 25.0), (25.0, 30.0)],
            )
            self.assertEqual(
                transcripts[0]["speech_text"],
                "\n".join(
                    [
                        "block_0001_chunk_001",
                        "block_0001_chunk_002",
                        "block_0001_chunk_003",
                    ]
                ),
            )
            self.assertEqual(
                transcripts[0]["cloud_audio_chunk_count"],
                3,
            )
            self.assertEqual(statistics["block_request_count"], 1)
            self.assertEqual(statistics["audio_chunk_request_count"], 3)

    def test_cloud_engine_writes_existing_transcript_structure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "lesson.mp4"
            video.write_bytes(b"fake-video")
            result = root / "result.json"
            result.write_text(
                json.dumps(
                    {
                        "video_id": "lesson",
                        "segments": [
                            {
                                "segment_id": 1,
                                "start_sec": 0.0,
                                "end_sec": 10.0,
                                "screenshot_path": "block_001.jpg",
                            }
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            output = root / "cloud"

            def extractor(
                _: Path,
                __: float,
                ___: float,
                audio_path: Path,
            ) -> None:
                audio_path.write_bytes(b"W" * 100)

            payload = transcribe_video_blocks(
                video,
                result,
                config=TranscriptionConfig(
                    engine="mimo-cloud",
                    mimo_max_concurrency=1,
                ),
                output_dir=output,
                api_key="test-key",
                cloud_requester=lambda _: "这是云端识别文字。",
                audio_extractor=extractor,
            )
            self.assertEqual(payload["transcription"]["engine"], "mimo-cloud")
            self.assertEqual(
                payload["transcription"]["model"],
                "mimo-v2.5-asr",
            )
            self.assertEqual(
                payload["segments"][0]["speech_text"],
                "这是云端识别文字。",
            )
            self.assertTrue((output / "transcript.json").is_file())
            self.assertTrue((output / "分段语音文字.md").is_file())
            self.assertEqual(list(output.glob("*.wav")), [])


if __name__ == "__main__":
    unittest.main()
