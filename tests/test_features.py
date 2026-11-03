"""Review workflow: evidence, human decisions, history, retries, cancellation, rules and exports."""
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from short_video_moderation import desktop, library
from short_video_moderation.errors import Cancelled
from short_video_moderation.evidence import segment_clip, segment_evidence, split_video
from short_video_moderation.limits import Limiter
from short_video_moderation.media import run_cancellable
from short_video_moderation.pipeline import decision, fingerprint, run_models, validate_policy
from short_video_moderation.providers import ProviderConfig

POLICY = {'version': 't', 'review_threshold': 0.4, 'block_threshold': 0.8, 'categories': {
    'violence': {'label': '暴力', 'question': 'q', 'positive': 'p', 'negative': 'n', 'block_threshold': 0.5},
    'hate': {'question': 'q', 'positive': 'p', 'negative': 'n'}}}
JEV = ProviderConfig('jev', 'https://jev.test/v1', 'jev', 'T_JEV', max_attempts=1)
LLM = ProviderConfig('openai', 'https://llm.test/v1', 'm', 'T_LLM', max_attempts=1)
FFMPEG = shutil.which('ffmpeg') and shutil.which('ffprobe')


def make_job(root, segments=3):
    """A results folder laid out like a real review: moderation-*/inputs.json, frames, evaluation-*/report.json."""
    job = Path(root) / 'moderation-20260101-000000-abcdef'
    (job / 'frames').mkdir(parents=True)
    items = []
    for i in range(segments):
        image = job / 'frames' / f'frame_{i}.jpg'
        Image.new('RGB', (400, 300), (40 * i, 80, 160)).save(image)
        frame = {'time_sec': float(i), 'path': image.as_posix(), 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}
        segment = {'segment_id': i + 1, 'start_sec': float(i), 'end_sec': float(i + 1), 'frames': [frame],
                   'speech_text': f'第{i + 1}句', 'utterances': [], 'audio_status': 'transcribed'}
        segment['input_hash'] = fingerprint(segment)
        items.append(segment)
    manifest = {'segments': items, 'sampling': {}, 'video_path': str(Path(root) / 'v.mp4'), 'duration_sec': float(segments)}
    manifest['input_hash'] = fingerprint(manifest)
    (job / 'inputs.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    return job, manifest


class RulesTests(unittest.TestCase):
    def test_categories_can_override_thresholds(self):
        validate_policy(POLICY)
        self.assertEqual(decision({'violence': 0.6, 'hate': 0.1}, POLICY), 'block')   # own block threshold 0.5
        self.assertEqual(decision({'violence': 0.1, 'hate': 0.6}, POLICY), 'review')  # global thresholds
        bad = json.loads(json.dumps(POLICY))
        bad['categories']['hate']['review_threshold'] = 0.9
        with self.assertRaises(ValueError):
            validate_policy(bad)

    def test_default_hold_band_is_065_to_08_and_old_saved_default_moves(self):
        policy = desktop.load_defaults()['policy']
        self.assertEqual((policy['review_threshold'], policy['block_threshold']), (0.65, 0.8))
        self.assertEqual(decision({'violence': 0.6}, policy), 'allow')
        self.assertEqual(decision({'violence': 0.7}, policy), 'review')
        self.assertEqual(decision({'violence': 0.8}, policy), 'block')
        old = dict(policy, review_threshold=0.4)
        self.assertEqual(desktop.migrate_policy(old)['review_threshold'], 0.65)
        # Hand-edited or calibrated thresholds are left alone.
        self.assertEqual(desktop.migrate_policy(dict(old, block_threshold=0.9))['review_threshold'], 0.4)
        self.assertEqual(desktop.migrate_policy(dict(old, calibrated_at='2026/11/1'))['review_threshold'], 0.4)

    def test_disabled_categories_are_left_out_and_presets_are_valid(self):
        policy = json.loads(json.dumps(POLICY))
        policy['categories']['hate']['enabled'] = False
        resolved = desktop.resolve_policy({'policy': policy})
        self.assertEqual(list(resolved['categories']), ['violence'])
        presets = desktop.category_presets()
        validate_policy({'version': 'p', 'review_threshold': 0.4, 'block_threshold': 0.8, 'categories': presets})
        self.assertTrue(all(rule['label'] for rule in presets.values()))


class RunControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job, self.manifest = make_job(self.temp.name)

    def test_retrying_failed_windows_merges_into_the_earlier_report(self):
        async def first(segment, policy, config, key, **kwargs):
            if config.provider == 'jev' and segment['segment_id'] == 2:
                raise RuntimeError('boom')
            return {'probabilities': {'violence': 0.1, 'hate': 0.1}, 'usage': {'total_tokens': 10}}
        previous = asyncio.run(run_models(self.manifest, POLICY, [JEV, LLM], self.job, keys={'jev': 'k', 'openai': 'k'}, evaluator=first))
        self.assertFalse(previous['providers']['jev']['complete'])
        self.assertEqual(previous['providers']['openai']['usage'], {'total_tokens': 30})
        sent = []
        async def second(segment, policy, config, key, **kwargs):
            sent.append((config.provider, segment['segment_id']))
            return {'probabilities': {'violence': 0.2, 'hate': 0.1}}
        merged = asyncio.run(run_models(self.manifest, POLICY, [JEV, LLM], self.job, keys={'jev': 'k', 'openai': 'k'},
                                        evaluator=second, only_segments={'jev': {2}, 'openai': set()}, previous=previous))
        self.assertEqual(sent, [('jev', 2)])
        self.assertTrue(merged['providers']['jev']['complete'])
        self.assertEqual([r['segment_id'] for r in merged['providers']['openai']['segments']], [1, 2, 3])
        self.assertEqual(merged['retry_of'], previous['report_path'])
        self.assertNotEqual(merged['report_path'], previous['report_path'])

    def test_stop_on_block_skips_windows_not_yet_sent(self):
        async def judge(segment, policy, config, key, **kwargs):
            return {'probabilities': {'violence': 0.9 if segment['segment_id'] == 1 else 0.1, 'hate': 0.0}}
        report = asyncio.run(run_models(self.manifest, POLICY, [JEV], self.job, keys={'jev': 'k'}, evaluator=judge,
                                        limiters={'jev': Limiter(1)}, stop_on_block=True))
        rows = report['providers']['jev']['segments']
        self.assertEqual(rows[0]['action'], 'block')
        self.assertEqual({r['skip_reason'] for r in rows[1:]}, {'stopped_after_block'})
        self.assertTrue(report['providers']['jev']['complete'])

    def test_should_stop_cancels_the_run(self):
        async def judge(segment, policy, config, key, **kwargs):
            return {'probabilities': {'violence': 0.1, 'hate': 0.1}}
        with self.assertRaises(Cancelled):
            asyncio.run(run_models(self.manifest, POLICY, [JEV], self.job, keys={'jev': 'k'}, evaluator=judge,
                                   should_stop=lambda: True))

    def test_cancelling_stops_a_running_subprocess_quickly(self):
        flag = threading.Event()
        threading.Timer(0.4, flag.set).start()
        started = time.monotonic()
        with self.assertRaises(Cancelled):
            run_cancellable([sys.executable, '-c', 'import time; time.sleep(30)'], should_stop=flag.is_set)
        self.assertLess(time.monotonic() - started, 5)


class DesktopJobTests(unittest.TestCase):
    def test_cancel_reaches_a_running_video(self):
        events, started = [], threading.Event()

        def slow_prepare(*args, should_stop=None, **kwargs):
            started.set()
            while not should_stop():
                time.sleep(0.02)
            raise Cancelled()
        with patch.object(desktop, 'prepare', side_effect=slow_prepare), \
                patch.dict(os.environ, {'TYPESAFE_API_KEY': 'k', 'LLM_API_KEY': 'k'}):
            thread = desktop.start_moderation(dict(job_id='a', video_path='x.mp4', output_root=tempfile.gettempdir(),
                                                   upload_consent=True, settings={'skip_reviewed': False}),
                                              lambda event, **data: events.append((event, data)))
            self.assertTrue(started.wait(5))
            self.assertEqual(desktop.cancel_jobs('a'), 1)
            thread.join(5)
        self.assertEqual(events[-1][0], 'moderation.cancelled')
        self.assertEqual(events[-1][1]['job_id'], 'a')

    def test_identical_video_is_not_reviewed_twice(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root) / 'v.mp4'
            video.write_bytes(b'video-bytes' * 100)
            report_file = Path(root) / 'moderation-x' / 'evaluation-y' / 'report.json'
            report_file.parent.mkdir(parents=True)
            report_file.write_text(json.dumps({'providers': {'jev': {'complete': True, 'segments': []}}}), encoding='utf-8')
            events = []
            with patch.object(desktop, 'prepare', side_effect=AssertionError('must reuse')), \
                    patch.object(desktop, 'run_signature', return_value='sig'), \
                    patch.dict(os.environ, {'TYPESAFE_API_KEY': 'k', 'LLM_API_KEY': 'k'}):
                library.remember_reviewed(Path(root).resolve(), library.video_fingerprint(video), 'sig', report_file)
                thread = desktop.start_moderation(dict(job_id='b', video_path=str(video), output_root=root, upload_consent=True,
                                                       settings={'skip_reviewed': True}),
                                                  lambda event, **data: events.append((event, data)))
                thread.join(5)
        self.assertEqual(events[-1][0], 'moderation.completed')
        self.assertTrue(events[-1][1]['cached'])

    def test_retry_failed_reuses_inputs_policy_and_only_failed_windows(self):
        with tempfile.TemporaryDirectory() as root:
            job, manifest = make_job(root)
            previous = {'input_hash': manifest['input_hash'], 'policy': POLICY, 'modality': 'visual', 'providers': {
                'jev': {'complete': False, 'segments': [{'segment_id': 1, 'status': 'completed'}, {'segment_id': 2, 'status': 'failed'}]}}}
            source = job / 'evaluation-old' / 'report.json'
            source.parent.mkdir()
            source.write_text(json.dumps(previous), encoding='utf-8')
            seen = {}

            async def fake_run(manifest_arg, policy, configs, destination, **kwargs):
                seen.update(policy=policy, providers=[c.provider for c in configs], **kwargs)
                return {'report_path': 'new', 'providers': {}}
            events = []
            with patch.object(desktop, 'run_models', side_effect=fake_run), patch.dict(os.environ, {'TYPESAFE_API_KEY': 'k'}):
                thread = desktop.start_evaluation(dict(job_id='c', report_path=str(source), retry_failed=True, settings={}),
                                                  lambda event, **data: events.append((event, data)))
                thread.join(5)
        self.assertEqual(events[-1][0], 'moderation.completed', events[-1])
        self.assertEqual(seen['only_segments'], {'jev': {2}})
        self.assertEqual(seen['policy'], POLICY)
        self.assertEqual(seen['modality'], 'visual')
        self.assertEqual(seen['providers'], ['jev'])


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_history_lists_latest_report_with_human_decision(self):
        job, manifest = make_job(self.root)
        for name, verdict in (('evaluation-1', 'old'), ('evaluation-2', 'new')):
            (job / name).mkdir()
            (job / name / 'report.json').write_text(json.dumps({'tag': verdict, 'providers': {}}), encoding='utf-8')
            time.sleep(0.02)
        latest = job / 'evaluation-2' / 'report.json'
        library.save_review(latest, 'block', '画面有打斗')
        entries = library.list_history(self.root)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['report']['tag'], 'new')
        self.assertEqual(entries[0]['report']['video_path'], manifest['video_path'])
        self.assertEqual((entries[0]['review']['decision'], entries[0]['runs']), ('block', 2))
        library.save_review(latest, None)
        self.assertIsNone(library.list_history(self.root)[0]['review'])
        with self.assertRaises(ValueError):
            library.save_review(self.root / 'elsewhere' / 'report.json', 'allow')

    def test_settings_are_saved_without_keys_and_csv_opens_in_excel(self):
        with patch.dict(os.environ, {'SVM_RUNTIME_ROOT': str(self.root)}):
            old_policy = dict(desktop.load_defaults()['policy'], review_threshold=0.4)
            library.save_settings({'llm_api_key': 'secret', 'jev_api_key': 'secret', 'video_concurrency': 5, 'policy': old_policy})
            saved = (self.root / 'settings.json').read_text(encoding='utf-8')
            self.assertNotIn('secret', saved)
            self.assertEqual(desktop.initial_settings()['video_concurrency'], 5)
            self.assertEqual(desktop.initial_settings()['policy']['review_threshold'], 0.65)
            # One knob: the video concurrency also sets the shared ASR and model request limits.
            with patch.dict(os.environ, {'TYPESAFE_API_KEY': 'k', 'LLM_API_KEY': 'k'}):
                desktop._context({'settings': {'video_concurrency': 5, 'asr_concurrency': 2}})
            from short_video_moderation.limits import ASR_REQUESTS, MODEL_REQUESTS
            self.assertEqual((ASR_REQUESTS.limit, MODEL_REQUESTS['jev'].limit, MODEL_REQUESTS['openai'].limit), (5, 5, 5))
            library.save_settings({'asr_concurrency': 3, 'jev_price_per_mtok': 1})
            self.assertNotIn('asr_concurrency', desktop.initial_settings())
        path = library.export_csv(self.root / 'out.csv', [['视频', '结论'], ['a.mp4', '拦截']])
        self.assertTrue(Path(path).read_bytes().startswith(b'\xef\xbb\xbf'))
        with self.assertRaises(ValueError):
            library.export_csv(self.root / 'out.exe', [['x']])

    def test_reports_are_revealed_only_from_review_folders(self):
        self.assertEqual(library.reveal_command('D:/results/moderation-a/evaluation-b/report.json', 'win32'),
                         'explorer /select,"' + os.path.normpath('D:/results/moderation-a/evaluation-b/report.json') + '"')
        self.assertEqual(library.reveal_command('/r/moderation-a/evaluation-b/report.json', 'darwin')[:2], ['open', '-R'])
        self.assertEqual(library.reveal_command('/r/moderation-a/evaluation-b/report.json', 'linux'), ['xdg-open', '/r/moderation-a/evaluation-b'])
        with self.assertRaises(ValueError):
            library.reveal_report(self.root / 'notes.txt')
        with self.assertRaises(FileNotFoundError):
            library.reveal_report(self.root / 'moderation-x' / 'evaluation-y' / 'report.json')

    def test_fingerprint_follows_content(self):
        a, b = self.root / 'a.mp4', self.root / 'b.mp4'
        a.write_bytes(b'x' * 10)
        b.write_bytes(b'x' * 10)
        self.assertEqual(library.video_fingerprint(a), library.video_fingerprint(b))
        b.write_bytes(b'x' * 11)
        self.assertNotEqual(library.video_fingerprint(a), library.video_fingerprint(b))


class EvidenceTests(unittest.TestCase):
    def test_segment_evidence_returns_frames_and_transcript_of_that_window(self):
        with tempfile.TemporaryDirectory() as root:
            job, manifest = make_job(root)
            report = job / 'evaluation-1' / 'report.json'
            report.parent.mkdir()
            report.write_text('{}', encoding='utf-8')
            evidence = segment_evidence(report, 2)
            self.assertEqual((evidence['speech_text'], evidence['frame_count']), ('第2句', 1))
            self.assertTrue(evidence['frames'][0]['data_url'].startswith('data:image/jpeg;base64,'))
            # Frames outside the review folder are never read.
            manifest['segments'][1]['frames'][0]['path'] = str(Path(root) / 'outside.jpg')
            Image.new('RGB', (10, 10)).save(Path(root) / 'outside.jpg')
            (job / 'inputs.json').write_text(json.dumps(manifest), encoding='utf-8')
            self.assertEqual(segment_evidence(report, 2)['frames'], [])

    @unittest.skipUnless(FFMPEG, 'FFmpeg required')
    def test_clip_and_long_video_split(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'SVM_RUNTIME_ROOT': root}):
            video = Path(root) / 'long.mp4'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=6:r=10',
                            '-f', 'lavfi', '-i', 'sine=d=6', '-g', '10', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(video)],
                           check=True, capture_output=True)
            mime, data = segment_clip(video, 1.0, 3.0)
            self.assertIn(mime, ('video/mp4', 'video/webm'))
            self.assertGreater(len(data), 100)
            parts = split_video(video, part_sec=2)
            self.assertGreaterEqual(len(parts), 3)
            self.assertAlmostEqual(parts[-1]['end_sec'], 6.0, delta=0.5)
            self.assertEqual(split_video(video, part_sec=2), parts, 'second call reuses the cached parts')


class WorkerProtocolTests(unittest.TestCase):
    def test_worker_answers_requests_with_their_id(self):
        with tempfile.TemporaryDirectory() as root:
            job, _ = make_job(root)
            report = job / 'evaluation-1' / 'report.json'
            report.parent.mkdir()
            report.write_text(json.dumps({'providers': {}}), encoding='utf-8')
            commands = [
                {'action': 'initialize'},
                {'action': 'save_review', 'payload': {'request_id': 'r1', 'report_path': str(report), 'decision': 'allow'}},
                {'action': 'segment_evidence', 'payload': {'request_id': 'r2', 'report_path': str(report), 'segment_id': 1}},
                {'action': 'moderation_cancel', 'payload': {'job_id': 'none'}},
            ]
            result = subprocess.run([sys.executable, '-m', 'short_video_moderation.worker'],
                                    input='\n'.join(json.dumps(c) for c in commands) + '\n',
                                    capture_output=True, text=True, encoding='utf-8', timeout=30, check=True,
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'SVM_RUNTIME_ROOT': root})
            # history is read after the review was written
            listed = subprocess.run([sys.executable, '-m', 'short_video_moderation.worker'],
                                    input=json.dumps({'action': 'list_history', 'payload': {'request_id': 'r3', 'output_root': root}}) + '\n',
                                    capture_output=True, text=True, encoding='utf-8', timeout=30, check=True,
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'SVM_RUNTIME_ROOT': root})
        events = [json.loads(line) for line in (result.stdout + listed.stdout).splitlines()]
        by_type = {e['type']: e for e in events}
        ready = by_type['worker.ready']['settings']
        self.assertIn('sexual', ready['category_presets'])
        self.assertEqual(ready['policy']['categories']['violence']['label'], '暴力')
        self.assertEqual(by_type['review.saved']['review']['decision'], 'allow')
        self.assertEqual(by_type['segment.evidence']['request_id'], 'r2')
        self.assertEqual(by_type['moderation.cancel_requested']['count'], 0)
        self.assertEqual(by_type['history.loaded']['entries'][0]['review']['decision'], 'allow')


if __name__ == '__main__':
    unittest.main()
