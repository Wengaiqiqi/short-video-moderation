import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from short_video_moderation.transcription import (
    SpeechUtterance,
    TranscriptionConfig,
    assign_utterances_to_blocks,
    format_timestamp,
    transcribe_video_blocks,
    validate_video_and_block_duration,
)


class _FakeModel:
    def transcribe(self, _: str, **__: object):
        segments = [
            SimpleNamespace(
                start=2.0,
                end=4.0,
                text="嗯，第一段。",
                avg_logprob=-0.1,
                no_speech_prob=0.01,
            ),
            SimpleNamespace(
                start=8.0,
                end=12.0,
                text="跨段的一句话。",
                avg_logprob=-0.2,
                no_speech_prob=0.02,
            ),
            SimpleNamespace(
                start=15.0,
                end=17.0,
                text="学生的问题也保留。",
                avg_logprob=-0.3,
                no_speech_prob=0.03,
            ),
        ]
        info = SimpleNamespace(language="zh", language_probability=0.99)
        return iter(segments), info


class TranscriptionTests(unittest.TestCase):
    def test_formats_timestamp(self) -> None:
        self.assertEqual(format_timestamp(3661.125), "01:01:01.125")

    def test_cross_block_sentence_uses_largest_overlap(self) -> None:
        blocks = [
            {"segment_id": 1, "start_sec": 0.0, "end_sec": 10.0},
            {"segment_id": 2, "start_sec": 10.0, "end_sec": 20.0},
        ]
        utterance = SpeechUtterance(8.0, 14.0, "跨段句子")
        assigned = assign_utterances_to_blocks(blocks, [utterance])
        self.assertEqual(assigned[0], [])
        self.assertEqual(assigned[1], [utterance])

    def test_rejects_video_and_block_duration_mismatch(self) -> None:
        with self.assertRaisesRegex(ValueError, "时长与音频时间段不匹配"):
            validate_video_and_block_duration(45.0, 2184.362)

    def test_accepts_small_duration_rounding_difference(self) -> None:
        validate_video_and_block_duration(2184.1, 2184.362)

    def test_transcribes_and_writes_block_text_without_audio(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "lesson.mp4"
            video.write_bytes(b"fake")
            result_path = root / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "video_id": "lesson",
                        "video_duration_sec": 20.0,
                        "segments": [
                            {
                                "segment_id": 1,
                                "start_sec": 0.0,
                                "end_sec": 10.0,
                                "screenshot_path": "block_001.jpg",
                            },
                            {
                                "segment_id": 2,
                                "start_sec": 10.0,
                                "end_sec": 20.0,
                                "screenshot_path": "block_002.jpg",
                            },
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            output = root / "text"
            payload = transcribe_video_blocks(
                video,
                result_path,
                config=TranscriptionConfig(model="tiny"),
                output_dir=output,
                model_factory=lambda _: _FakeModel(),
            )
            self.assertEqual(payload["transcription"]["utterance_count"], 3)
            self.assertIn("嗯，第一段。", payload["segments"][0]["speech_text"])
            self.assertIn(
                "学生的问题也保留。",
                payload["segments"][1]["speech_text"],
            )
            self.assertTrue((output / "transcript.json").is_file())
            self.assertTrue((output / "分段语音文字.md").is_file())
            self.assertEqual(list(output.glob("*.wav")), [])


if __name__ == "__main__":
    unittest.main()
