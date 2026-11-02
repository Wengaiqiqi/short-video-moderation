import asyncio
import base64
import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image

from short_video_moderation.pipeline import prepare, run_models, fingerprint, decision
from short_video_moderation.alignment import align_evidence
from short_video_moderation.sampling import SamplingConfig
from short_video_moderation.providers import ProviderConfig, build_request, normalize_response, evaluate
from short_video_moderation.transcription import TranscriptionConfig

POLICY = {'version': 'test-v1', 'review_threshold': 0.4, 'block_threshold': 0.8,
          'categories': {'violence': {'question': 'Is violence depicted?', 'positive': 'Assault.', 'negative': 'No assault.'}}}
JEV = ProviderConfig('jev', 'https://api.typesafe.ai/v1', 'jev-1.14.0', 'TEST_JEV', max_attempts=1)
BASELINE = ProviderConfig('openai', 'https://example.test/v1', 'baseline', 'TEST_LLM', max_attempts=1)


class ModerationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        image = self.root / 'frame.jpg'
        Image.new('RGB', (320, 320), 'red').save(image)
        self.frame = {'time_sec': 0.0, 'path': str(image), 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}
        self.segment = {'segment_id': 1, 'start_sec': 0, 'end_sec': 2, 'frames': [self.frame], 'speech_text': '', 'audio_status': 'absent'}
        self.segment['input_hash'] = fingerprint(self.segment)
        self.manifest = {'segments': [self.segment], 'sampling': {'interval_sec': 0.5}}
        self.manifest['input_hash'] = fingerprint(self.manifest)

    def test_speech_led_windows_preserve_silent_coverage_and_all_frames(self):
        frames = [dict(self.frame, time_sec=i / 2) for i in range(24)]
        utterances = [{'start_sec': 1, 'end_sec': 3, 'text': 'first'}, {'start_sec': 5, 'end_sec': 11, 'text': 'second'}]
        segments = align_evidence(frames, utterances, 12, max_seconds=4, max_frames=4)
        self.assertEqual(segments[0]['start_sec'], 0)
        self.assertEqual(segments[-1]['end_sec'], 12)
        self.assertTrue(any(s['start_sec'] == 1 and s['end_sec'] == 3 and s['speech_text'] == 'first' for s in segments))
        self.assertTrue(any(not s['speech_text'] and s['frames'] for s in segments))
        self.assertEqual([f['time_sec'] for s in segments for f in s['frames']], [f['time_sec'] for f in frames])
        self.assertTrue(all(a['end_sec'] == b['start_sec'] for a, b in zip(segments, segments[1:])))
        self.assertTrue(all(len(s['frames']) <= 4 and s['end_sec'] - s['start_sec'] <= 4 for s in segments))

    def test_jev_and_control_use_identical_image_bytes_and_policy(self):
        url, headers, jev = build_request(self.segment, POLICY, JEV)
        _, baseline_headers, baseline = build_request(self.segment, POLICY, BASELINE)
        asset = next(iter(jev['assets'].values()))
        image_url = baseline['messages'][1]['content'][-1]['image_url']['url']
        self.assertEqual(asset['data_base64'], image_url.split(',')[1])
        self.assertEqual(url, 'https://api.typesafe.ai/v1/systemone')
        self.assertEqual(headers['TypeSafe-Danger-Zone-Images'], 'true')
        self.assertNotIn('TypeSafe-Danger-Zone-Images', baseline_headers)
        self.assertEqual(jev['questions']['violence']['criteria']['true'], 'Assault.')
        self.assertEqual(base64.b64decode(asset['data_base64']), Path(self.frame['path']).read_bytes())

    def test_modalities_exclude_other_inputs(self):
        _, headers, text = build_request(dict(self.segment, speech_text='hello'), POLICY, JEV, 'text')
        self.assertNotIn('assets', text)
        self.assertEqual(headers, {})
        _, _, visual = build_request(dict(self.segment, speech_text='secret'), POLICY, JEV, 'visual')
        self.assertNotIn('speech_text', visual['state'])

    def test_jev_http_contract_and_response(self):
        def handler(request):
            self.assertEqual(request.headers['TypeSafe-Danger-Zone-Images'], 'true')
            self.assertEqual(request.headers['Authorization'], 'Bearer test-key')
            self.assertIn('Idempotency-Key', request.headers)
            body = json.loads(request.content)
            reference = body['state']['frames'][0]['image']
            self.assertIn(reference, body['assets'])
            return httpx.Response(200, json={'model': 'jev-1.14.0', 'answers': {'violence': {'type': 'noul', 'noul': 0.9}}, 'usage': {'input_tokens': 10}})
        result = asyncio.run(evaluate(self.segment, POLICY, JEV, 'test-key', transport=httpx.MockTransport(handler)))
        self.assertEqual(result['probabilities']['violence'], 0.9)
        self.assertEqual(decision(result['probabilities'], POLICY), 'block')

    def test_invalid_scores_are_not_silent_passes(self):
        for value in [True, float('nan'), 1.1, '0.5']:
            with self.assertRaises(ValueError):
                normalize_response({'answers': {'violence': {'type': 'noul', 'noul': value}}}, JEV, ['violence'])

    def test_failed_provider_still_runs_control_and_no_speech_is_evaluated(self):
        seen = []
        async def fake(segment, policy, config, key, **kwargs):
            seen.append((config.provider, segment['input_hash']))
            if config.provider == 'jev':
                raise RuntimeError('private error')
            return {'probabilities': {'violence': 0.9}, 'model': 'baseline'}
        report = asyncio.run(run_models(self.manifest, POLICY, [JEV, BASELINE], self.root,
                                         keys={'jev': 'key', 'openai': 'key'}, evaluator=fake))
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0][1], seen[1][1])
        self.assertEqual(report['providers']['jev']['segments'][0]['action'], 'review')
        self.assertFalse(report['providers']['jev']['complete'])
        self.assertEqual(report['providers']['openai']['segments'][0]['action'], 'block')
        self.assertNotIn('private error', Path(report['report_path']).read_text())

    def test_changed_image_rejected_before_inference(self):
        Path(self.frame['path']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'image changed'):
            asyncio.run(run_models(self.manifest, POLICY, [JEV], self.root, keys={'jev': 'key'}))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_speech_times_drive_final_windows_after_independent_asr(self):
        video = self.root / 'audio.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'color=c=red:s=320x180:d=6:r=20', '-f', 'lavfi', '-i',
                        'sine=frequency=440:duration=6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(video)],
                       check=True, capture_output=True)
        def fake_asr(video_path, result_path, **kwargs):
            audio_intervals = json.loads(Path(result_path).read_text())['segments']
            self.assertEqual(len(audio_intervals), 1)
            self.assertNotIn('frames', audio_intervals[0])
            return {'segments': [{'segment_id': 1, 'utterances': [
                {'start_sec': 1.5, 'end_sec': 3.5, 'text': 'spoken phrase'}]}]}
        with patch('short_video_moderation.pipeline.transcribe_video_blocks', side_effect=fake_asr):
            result = prepare(video, self.root / 'prepared', SamplingConfig(),
                             TranscriptionConfig(initial_prompt=None, hotwords=None))
        spoken = next(p for p in result['segments'] if p['speech_text'])
        self.assertEqual((spoken['start_sec'], spoken['end_sec']), (1.5, 3.5))
        self.assertTrue(all(1.5 <= f['time_sec'] < 3.5 for f in spoken['frames']))
        self.assertEqual(result['alignment']['precision'], 'asr_segment')
        self.assertEqual(result['segments'][0]['speech_text'], '')
        self.assertEqual(result['segments'][-1]['speech_text'], '')
        self.assertTrue(all(s['frames'] for s in result['segments']), 'every window keeps a frame after de-duplication')
        self.assertLess(result['frame_statistics']['kept'], result['frame_statistics']['sampled'])

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_silent_video_decoding_and_scene_supplement(self):
        video = self.root / 'input.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                        'color=c=red:s=320x180:d=0.75:r=20', '-f', 'lavfi', '-i',
                        'color=c=blue:s=320x180:d=1.25:r=20', '-filter_complex',
                        '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', str(video)], check=True, capture_output=True)
        result = prepare(video, self.root / 'prepared', SamplingConfig(interval_sec=0.5, dedupe_max_distance=0))
        frames = [f for s in result['segments'] for f in s['frames']]
        self.assertFalse(result['has_audio'])
        self.assertTrue(any(abs(f['time_sec'] - 0.75) < 0.06 for f in frames))
        self.assertTrue(all(b['time_sec'] - a['time_sec'] <= 0.55 for a,b in zip(frames, frames[1:])))
        # With de-duplication the flat colours collapse, but the red→blue cut is kept.
        deduped = prepare(video, self.root / 'deduped', SamplingConfig(interval_sec=0.5))
        kept = [f['time_sec'] for s in deduped['segments'] for f in s['frames']]
        self.assertLess(len(kept), len(frames))
        self.assertTrue(any(abs(t - 0.75) < 0.06 for t in kept))
        self.assertEqual(len(list((self.root / 'deduped' / 'frames').glob('*.jpg'))), len(kept))
        for frame in frames:
            with Image.open(frame['path']) as image:
                self.assertGreaterEqual(min(image.size), 280)
        self.assertEqual(result['alignment']['strategy'], 'speech_first_with_silent_windows')


if __name__ == '__main__':
    unittest.main()
