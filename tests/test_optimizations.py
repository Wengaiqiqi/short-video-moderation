"""Cloud-ASR chunking, window repair, partial failures and concurrency."""
import asyncio
import hashlib
import json
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image

from short_video_moderation.alignment import align_evidence
from short_video_moderation.cloud_asr import (
    MimoASRSettings, MimoHTTPError, WavSlicer, detect_silences, plan_speech_chunks, transcribe_blocks_with_mimo,
)
from short_video_moderation.limits import Limiter
from short_video_moderation.pipeline import fingerprint, prepare, run_models
from short_video_moderation.providers import ModelRequestError, ProviderConfig, evaluate
from short_video_moderation.sampling import SamplingConfig
from short_video_moderation.transcription import TranscriptionConfig

POLICY = {'version': 't', 'review_threshold': 0.4, 'block_threshold': 0.8,
          'categories': {'violence': {'question': 'q', 'positive': 'p', 'negative': 'n'}}}
JEV = ProviderConfig('jev', 'https://jev.test/v1', 'jev', 'T_JEV', max_attempts=2, max_concurrency=3)
LLM = ProviderConfig('openai', 'https://llm.test/v1', 'm', 'T_LLM', max_attempts=1, max_concurrency=3)
FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')


def frames_every(step, duration):
    return [{'time_sec': round(i * step, 3), 'path': f'f{i}.jpg'} for i in range(int(duration / step))]


class AlignmentRepairTests(unittest.TestCase):
    def test_pause_between_sentences_does_not_create_an_empty_window(self):
        utterances = [dict(start_sec=1.0, end_sec=3.2, text='一'), dict(start_sec=3.4, end_sec=6.0, text='二')]
        windows = align_evidence(frames_every(0.5, 12), utterances, 12.0)
        self.assertTrue(all(w['frames'] or w['speech_text'] for w in windows))
        self.assertTrue(all(w['end_sec'] - w['start_sec'] >= 1.0 for w in windows))
        self.assertEqual(windows[-1]['end_sec'], 12.0)

    def test_tail_sliver_merges_into_previous_window(self):
        windows = align_evidence(frames_every(0.5, 37.5), [dict(start_sec=30.0, end_sec=37.46, text='尾')], 37.52)
        self.assertGreater(windows[-1]['end_sec'] - windows[-1]['start_sec'], 1.0)

    def test_frame_budget_splits_evenly_without_slivers(self):
        frames = frames_every(0.25, 8)  # 32 frames in one 8 s window, budget 16 → two halves
        windows = align_evidence(frames, [], 8.0, max_frames=16)
        self.assertEqual([len(w['frames']) for w in windows], [16, 16])

    def test_long_silence_is_cut_evenly(self):
        windows = align_evidence(frames_every(0.5, 10), [], 10.0, max_seconds=8)
        self.assertEqual([round(w['end_sec'] - w['start_sec'], 3) for w in windows], [5.0, 5.0])

    def test_failed_audio_marks_overlapping_windows(self):
        windows = align_evidence(frames_every(0.5, 16), [], 16.0, max_seconds=8, failed_audio=[(9.0, 12.0)])
        self.assertEqual([w['audio_status'] for w in windows], ['transcribed', 'asr_failed'])


class ChunkPlanTests(unittest.TestCase):
    def test_speech_is_cut_at_pauses_and_silence_is_skipped(self):
        # speech 0–3, 3.5–6, 10–20 (continuous), silence 6–10 and 20–25
        blocks = plan_speech_chunks(25.0, [(3.0, 3.5), (6.0, 10.0), (20.0, 25.0)], [(14.9, 15.1)], max_sec=8)
        self.assertEqual(blocks[0]['start_sec'], 0.0)
        self.assertEqual(blocks[-1]['end_sec'], 25.0)
        self.assertTrue(all(a['end_sec'] == b['start_sec'] for a, b in zip(blocks, blocks[1:])))
        speech = [b for b in blocks if not b['skip']]
        self.assertTrue(all(b['end_sec'] - b['start_sec'] <= 8.0 + 1e-6 for b in speech))
        self.assertTrue(any(b['skip'] and b['start_sec'] >= 6.0 and b['end_sec'] <= 10.0 for b in blocks))
        # 0–6 with a 0.5 s pause merges into one chunk; 10–20 is cut at the quiet dip near 15 s
        self.assertAlmostEqual(speech[0]['end_sec'], 6.15, places=2)
        self.assertTrue(any(abs(b['end_sec'] - 15.0) < 0.01 for b in speech))

    def test_continuous_sound_without_dips_falls_back_to_fixed_cuts(self):
        blocks = plan_speech_chunks(20.0, [], [], max_sec=8)
        self.assertEqual([(b['start_sec'], b['end_sec'], b['skip']) for b in blocks],
                         [(0.0, 8.0, False), (8.0, 16.0, False), (16.0, 20.0, False)])

    def test_all_silence_uploads_nothing(self):
        blocks = plan_speech_chunks(5.0, [(0.0, 5.0)], [], max_sec=8)
        self.assertTrue(all(b['skip'] for b in blocks))

    @unittest.skipUnless(FFMPEG, 'FFmpeg required')
    def test_silencedetect_and_slicer_on_real_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / 'a.wav'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2',
                            '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1.5', '-f', 'lavfi', '-i', 'sine=f=440:d=2',
                            '-filter_complex', '[0:a]aresample=16000[a];[2:a]aresample=16000[c];[a][1:a][c]concat=n=3:v=0:a=1',
                            '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav)], check=True, capture_output=True)
            silences = detect_silences(wav, noise_db=-35, min_silence_sec=0.3)
            self.assertEqual(len(silences), 1)
            self.assertAlmostEqual(silences[0][0], 2.0, delta=0.1)
            self.assertAlmostEqual(silences[0][1], 3.5, delta=0.1)
            out = Path(directory) / 'slice.wav'
            WavSlicer(wav)(wav, 1.0, 2.5, out)
            with wave.open(str(out)) as sliced:
                self.assertAlmostEqual(sliced.getnframes() / sliced.getframerate(), 1.5, places=2)


class CloudFailureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.video = Path(self.temp.name) / 'v.mp4'
        self.video.write_bytes(b'x')
        self.extract = lambda _v, _s, _e, out: out.write_bytes(b'R' * 100)

    def blocks(self):
        return [{'segment_id': 1, 'start_sec': 0, 'end_sec': 4, 'skip': False},
                {'segment_id': 2, 'start_sec': 4, 'end_sec': 9, 'skip': True},
                {'segment_id': 3, 'start_sec': 9, 'end_sec': 12, 'skip': False}]

    def test_silent_blocks_are_not_uploaded_and_one_failure_does_not_stop_the_video(self):
        uploaded = []
        def requester(path):
            uploaded.append(path.stem)
            if path.stem == 'block_0003':
                raise MimoHTTPError(503)
            return '你好'
        transcripts, stats = transcribe_blocks_with_mimo(
            self.video, self.blocks(), settings=MimoASRSettings(max_retries=2), api_key='k',
            requester=requester, audio_extractor=self.extract)
        self.assertNotIn('block_0002', uploaded)
        self.assertEqual([t['asr_status'] for t in transcripts], ['transcribed', 'silent', 'failed'])
        self.assertEqual(uploaded.count('block_0003'), 2, 'HTTP 503 is retried')
        self.assertEqual((stats['block_request_count'], stats['failed_block_count']), (2, 1))

    def test_auth_errors_are_not_retried_and_total_failure_raises(self):
        calls = []
        def requester(path):
            calls.append(path.stem)
            raise MimoHTTPError(401)
        with self.assertRaises(MimoHTTPError) as caught:
            transcribe_blocks_with_mimo(self.video, self.blocks(), settings=MimoASRSettings(max_retries=3),
                                        api_key='k', requester=requester, audio_extractor=self.extract)
        self.assertEqual(len(calls), 2, 'one attempt per uploaded block')
        self.assertIn('401', str(caught.exception))

    def test_global_limiter_caps_parallel_uploads(self):
        limiter, active, peak, lock = Limiter(1), [0], [0], threading.Lock()
        def requester(_):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.05)
            with lock:
                active[0] -= 1
            return '好'
        blocks = [{'segment_id': i, 'start_sec': i, 'end_sec': i + 1} for i in range(1, 5)]
        transcribe_blocks_with_mimo(self.video, blocks, settings=MimoASRSettings(max_concurrency=4), api_key='k',
                                    requester=requester, audio_extractor=self.extract, limiter=limiter)
        self.assertEqual(peak[0], 1)


class RunModelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        image = self.root / 'f.jpg'
        Image.new('RGB', (300, 300), 'red').save(image)
        frame = {'time_sec': 0.0, 'path': str(image), 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}
        segments = []
        for i in range(6):
            segments.append({'segment_id': i + 1, 'start_sec': i, 'end_sec': i + 1, 'frames': [frame],
                             'speech_text': '话' if i % 2 else '', 'audio_status': 'transcribed'})
        segments[4].update(frames=[], speech_text='')                  # nothing to judge → skipped
        segments[5].update(audio_status='asr_failed', speech_text='')  # speech lost → review
        for segment in segments:
            segment['input_hash'] = fingerprint(segment)
        self.manifest = {'segments': segments, 'sampling': {}}
        self.manifest['input_hash'] = fingerprint(self.manifest)

    def test_requests_run_concurrently_within_the_limit(self):
        active, peak, messages = [0], [0], []
        async def fake(segment, policy, config, key, **kwargs):
            active[0] += 1
            peak[0] = max(peak[0], active[0])
            await asyncio.sleep(0.05)
            active[0] -= 1
            return {'probabilities': {'violence': 0.1}}
        limiters = {'jev': Limiter(2), 'openai': Limiter(2)}
        started = time.perf_counter()
        report = asyncio.run(run_models(self.manifest, POLICY, [JEV, LLM], self.root, keys={'jev': 'k', 'openai': 'k'},
                                        evaluator=fake, limiters=limiters, progress=messages.append))
        self.assertLessEqual(peak[0], 4)
        self.assertGreater(peak[0], 1)
        self.assertLess(time.perf_counter() - started, 10 * 0.05)
        self.assertIn('jev: 完成 0/6', messages)
        self.assertIn('openai: 完成 6/6', messages)
        rows = report['providers']['jev']['segments']
        self.assertEqual([r['segment_id'] for r in rows], [1, 2, 3, 4, 5, 6])
        self.assertEqual(rows[4]['status'], 'skipped')
        self.assertEqual((rows[5]['status'], rows[5]['action'], rows[5]['evidence']), ('completed', 'review', 'asr_failed'))
        self.assertTrue(report['providers']['jev']['complete'])

    def test_model_failures_are_reported_with_codes(self):
        async def fake(segment, policy, config, key, **kwargs):
            raise ModelRequestError('http_401')
        report = asyncio.run(run_models(self.manifest, POLICY, [JEV], self.root, keys={'jev': 'k'}, evaluator=fake))
        failed = [r for r in report['providers']['jev']['segments'] if r['status'] == 'failed']
        self.assertTrue(failed)
        self.assertTrue(all(r['error_type'] == 'http_401' for r in failed))

    def test_retry_after_is_honoured_and_auth_errors_are_final(self):
        calls = []
        def handler(request):
            calls.append(1)
            if len(calls) == 1:
                return httpx.Response(429, headers={'Retry-After': '0'})
            return httpx.Response(200, json={'answers': {'violence': {'type': 'noul', 'noul': 0.2}}})
        result = asyncio.run(evaluate(self.manifest['segments'][0], POLICY, JEV, 'k', transport=httpx.MockTransport(handler)))
        self.assertEqual((len(calls), result['probabilities']['violence']), (2, 0.2))
        with self.assertRaises(ModelRequestError) as caught:
            asyncio.run(evaluate(self.manifest['segments'][0], POLICY, JEV, 'k',
                                 transport=httpx.MockTransport(lambda r: httpx.Response(401))))
        self.assertEqual(caught.exception.code, 'http_401')


@unittest.skipUnless(FFMPEG, 'FFmpeg required')
class CloudPrepareTests(unittest.TestCase):
    def test_cloud_asr_uploads_only_speech_chunks_and_uses_their_times(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / 'talk.mp4'
            # tone 0–3 s, silence 3–7 s, tone 7–9 s
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=9:r=10',
                            '-f', 'lavfi', '-i', 'sine=f=300:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=4',
                            '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-filter_complex',
                            '[1:a]aresample=44100[a];[3:a]aresample=44100[c];[a][2:a][c]concat=n=3:v=0:a=1[aud]',
                            '-map', '0:v', '-map', '[aud]', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(video)],
                           check=True, capture_output=True)
            uploads = []
            def fake_request(audio_path, **kwargs):
                with wave.open(str(audio_path)) as w:
                    uploads.append(w.getnframes() / w.getframerate())
                return f'第{len(uploads)}段'
            messages = []
            with patch('short_video_moderation.cloud_asr.request_mimo_asr', side_effect=fake_request):
                result = prepare(video, root / 'prepared', SamplingConfig(),
                                 TranscriptionConfig(engine='mimo-cloud', mimo_max_concurrency=2),
                                 asr_key='k', progress=messages.append)
            self.assertEqual(len(uploads), 2, 'the 4 s silence is not uploaded')
            self.assertTrue(all(d < 4 for d in uploads))
            self.assertEqual(result['alignment']['precision'], 'speech_chunk')
            self.assertEqual(result['asr_statistics']['skipped_silent'], 1)
            spoken = [s for s in result['segments'] if s['speech_text']]
            self.assertTrue(all(s['end_sec'] <= 3.5 or s['start_sec'] >= 6.5 for s in spoken))
            self.assertIn('语音识别 2/2', messages)
            self.assertFalse((root / 'prepared' / 'audio' / 'audio.wav').exists())


if __name__ == '__main__':
    unittest.main()
