"""Whole-transcript judgement next to the windows, and neighbouring sentences as window context."""
import asyncio
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image

from short_video_moderation import desktop, pipeline
from short_video_moderation.errors import Cancelled
from short_video_moderation.limits import Limiter
from short_video_moderation.pipeline import (fingerprint, run_models, speech_contexts, transcript_passages,
                                             transcript_sentences)
from short_video_moderation.providers import (CONTEXT_NOTE, ProviderConfig, build_request, build_transcript_request,
                                              evaluate_transcript, normalize_response)

POLICY = {'version': 't', 'review_threshold': 0.65, 'block_threshold': 0.8, 'categories': {
    'violence': {'question': 'q', 'positive': 'p', 'negative': 'n'},
    'hate': {'question': 'q', 'positive': 'p', 'negative': 'n'}}}
JEV = ProviderConfig('jev', 'https://jev.test/v1', 'jev', 'T_JEV', max_attempts=1)
LLM = ProviderConfig('openai', 'https://llm.test/v1', 'm', 'T_LLM', max_attempts=1)
KEYS = {'jev': 'k', 'openai': 'k'}
LOW = {'violence': 0.1, 'hate': 0.1}

# Three windows; the second sentence crosses the boundary between windows 2 and 3, window 4 is silent.
SPEECH = [
    [(0.0, 1.8, '今晚去老地方')],
    [(2.0, 3.6, '把那批货带上'), (3.6, 5.0, '别让人看见')],
    [(3.6, 5.0, '别让人看见'), (5.2, 6.0, '你懂的')],
    [],
]


def make_job(root, speech=SPEECH):
    job = Path(root) / 'moderation-20260101-000000-abcdef'
    (job / 'frames').mkdir(parents=True)
    items = []
    bounds = [(0.0, 2.0), (2.0, 4.0), (4.0, 6.0), (6.0, 8.0)]
    for i, ((start, end), lines) in enumerate(zip(bounds, speech)):
        image = job / 'frames' / f'frame_{i}.jpg'
        Image.new('RGB', (64, 48), (50 * i, 90, 140)).save(image)
        frame = {'time_sec': start, 'path': image.as_posix(), 'sha256': hashlib.sha256(image.read_bytes()).hexdigest()}
        utterances = [{'start_sec': a, 'end_sec': b, 'text': t} for a, b, t in lines]
        segment = {'segment_id': i + 1, 'start_sec': start, 'end_sec': end, 'frames': [frame],
                   'speech_text': '\n'.join(u['text'] for u in utterances), 'utterances': utterances,
                   'audio_status': 'transcribed' if utterances else 'no_speech'}
        segment['input_hash'] = fingerprint(segment)
        items.append(segment)
    manifest = {'segments': items, 'sampling': {}, 'video_path': str(Path(root) / 'v.mp4'), 'duration_sec': 8.0}
    manifest['input_hash'] = fingerprint(manifest)
    return job, manifest


class TranscriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job, self.manifest = make_job(self.temp.name)

    def test_sentences_are_numbered_once_and_know_their_windows(self):
        sentences = transcript_sentences(self.manifest['segments'])
        self.assertEqual([s['text'] for s in sentences], ['今晚去老地方', '把那批货带上', '别让人看见', '你懂的'])
        self.assertEqual([s['id'] for s in sentences], [1, 2, 3, 4])
        self.assertEqual(sentences[2]['segments'], [2, 3])

    def test_windows_get_the_sentence_before_and_after(self):
        segments = self.manifest['segments']
        contexts = speech_contexts(segments, transcript_sentences(segments))
        self.assertEqual(contexts[1], {'after': '把那批货带上'})
        self.assertEqual(contexts[2], {'before': '今晚去老地方', 'after': '你懂的'})
        self.assertEqual(contexts[3], {'before': '把那批货带上'})
        self.assertEqual(contexts[4], {'before': '你懂的'})          # silent window: the last thing said
        later = dict(segments[3], segment_id=9, start_sec=20.0, end_sec=22.0)
        self.assertNotIn(9, speech_contexts([later], transcript_sentences(segments)))   # 14 s away: not context

    def test_context_is_marked_as_context_and_never_sent_for_visual_only(self):
        segment = dict(self.manifest['segments'][1], speech_context={'before': '今晚去老地方', 'after': '你懂的'})
        _, _, payload = build_request(segment, POLICY, LLM, 'text')
        state = json.loads(payload['messages'][1]['content'][0]['text'])
        self.assertEqual((state['context_before'], state['context_after']), ('今晚去老地方', '你懂的'))
        self.assertIn(CONTEXT_NOTE, payload['messages'][0]['content'])
        _, _, payload = build_request(segment, POLICY, JEV, 'multimodal')
        self.assertEqual(payload['state']['context_after'], '你懂的')
        _, _, payload = build_request(segment, POLICY, JEV, 'visual')
        self.assertNotIn('context_before', payload['state'])
        self.assertNotIn(CONTEXT_NOTE, payload['questions']['violence']['instructions'])

    def test_full_text_request_is_text_only_and_lists_every_sentence(self):
        sentences = transcript_sentences(self.manifest['segments'])
        _, headers, payload = build_transcript_request(sentences, POLICY, JEV)
        self.assertNotIn('assets', payload)
        self.assertEqual(headers, {})
        self.assertEqual([s['id'] for s in payload['state']['transcript']], [1, 2, 3, 4])
        url, _, payload = build_transcript_request(sentences, POLICY, LLM)
        self.assertTrue(url.endswith('/chat/completions'))
        self.assertIn('"sentences"', payload['messages'][0]['content'])
        self.assertIn('把那批货带上', payload['messages'][1]['content'])

    def test_listed_sentences_are_checked(self):
        raw = {'choices': [{'message': {'content': json.dumps({
            'probabilities': {'violence': 0.2, 'hate': 0.7},
            'sentences': {'hate': [2, '3', 's4', 9, True, 2], 'violence': []}})}}]}
        result = normalize_response(raw, LLM, POLICY['categories'], sentence_ids=[1, 2, 3, 4])
        self.assertEqual(result['sentences'], {'hate': [2, 3, 4]})
        jev = normalize_response({'answers': {k: {'type': 'noul', 'noul': 0.3} for k in POLICY['categories']}},
                                 JEV, POLICY['categories'], sentence_ids=[1])
        self.assertEqual(jev['sentences'], {})

    def test_evaluate_transcript_over_http(self):
        def reply(request):
            body = json.loads(request.content)
            self.assertNotIn('image_url', json.dumps(body))
            content = json.dumps({'probabilities': {'violence': 0.1, 'hate': 0.9}, 'sentences': {'hate': [1]}})
            return httpx.Response(200, json={'choices': [{'message': {'content': content}}], 'usage': {'total_tokens': 42}})
        sentences = transcript_sentences(self.manifest['segments'])
        result = asyncio.run(evaluate_transcript(sentences, POLICY, LLM, 'key', transport=httpx.MockTransport(reply)))
        self.assertEqual(result['sentences'], {'hate': [1]})
        self.assertEqual(result['usage'], {'total_tokens': 42})

    def test_long_transcripts_are_split_into_overlapping_passages(self):
        sentences = [{'id': i + 1, 'start_sec': i, 'end_sec': i + 1, 'text': 'x' * 10} for i in range(10)]
        passages = transcript_passages(sentences, max_chars=40, overlap=1)
        self.assertTrue(all(len(p) <= 4 for p in passages))
        self.assertEqual(passages[0][-1]['id'], passages[1][0]['id'])     # one sentence of overlap
        self.assertEqual(passages[-1][-1]['id'], 10)
        self.assertEqual(transcript_passages(sentences[:2]), [sentences[:2]])


class FullTextRunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job, self.manifest = make_job(self.temp.name)

    def run_models(self, configs=(LLM,), **kwargs):
        return asyncio.run(run_models(self.manifest, POLICY, list(configs), self.job, keys=KEYS, **kwargs))

    def test_full_text_goes_first_and_finds_what_windows_miss(self):
        order, seen = [], {}

        async def window(segment, policy, config, key, **kwargs):
            order.append(('window', segment['segment_id']))
            seen[segment['segment_id']] = segment.get('speech_context')
            return {'probabilities': LOW, 'usage': {'total_tokens': 10}}

        async def whole(sentences, policy, config, key, **kwargs):
            order.append(('text', len(sentences)))
            return {'probabilities': {'violence': 0.2, 'hate': 0.9}, 'sentences': {'hate': [2, 3]},
                    'usage': {'total_tokens': 100}}
        messages = []
        report = self.run_models(evaluator=window, transcript_evaluator=whole, limiters={'openai': Limiter(1)},
                                 full_text=True, speech_context=True, progress=messages.append)
        self.assertEqual(order[0], ('text', 4))
        data = report['providers']['openai']
        text = data['transcript']
        self.assertEqual((text['status'], text['action']), ('completed', 'block'))
        self.assertEqual(text['windows'], [2, 3])                       # sentence 3 spans windows 2 and 3
        self.assertEqual(text['sentence_count'], 4)
        self.assertEqual({r['action'] for r in data['segments']}, {'allow'})
        self.assertEqual(data['usage'], {'total_tokens': 140})
        self.assertTrue(data['complete'])
        self.assertTrue(report['full_text'] and report['speech_context'])
        self.assertEqual(len(report['transcript']), 4)
        self.assertEqual(seen[2], {'before': '今晚去老地方', 'after': '你懂的'})
        self.assertIn('openai: 完成 5/5', messages)                      # four windows + the transcript
        markdown = Path(report['report_path']).with_suffix('.md').read_text(encoding='utf-8')
        self.assertIn('全文判断（openai）', markdown)

    def test_switched_off_or_visual_only_sends_no_transcript(self):
        async def window(segment, policy, config, key, **kwargs):
            self.assertNotIn('speech_context', segment)
            return {'probabilities': LOW}

        async def whole(*args, **kwargs):
            raise AssertionError('no full-text request expected')
        report = self.run_models(evaluator=window, transcript_evaluator=whole)
        self.assertNotIn('transcript', report['providers']['openai'])
        report = self.run_models(evaluator=window, transcript_evaluator=whole, modality='visual',
                                 full_text=True, speech_context=True)
        self.assertFalse(report['full_text'])
        self.assertNotIn('transcript', report)

    def test_a_video_without_speech_skips_the_transcript(self):
        self.job, self.manifest = make_job(self.temp.name + '/silent', speech=[[], [], [], []])

        async def window(segment, policy, config, key, **kwargs):
            return {'probabilities': LOW}
        report = self.run_models(evaluator=window, full_text=True)
        text = report['providers']['openai']['transcript']
        self.assertEqual((text['status'], text['skip_reason']), ('skipped', 'no_speech'))
        self.assertTrue(report['providers']['openai']['complete'])

    def test_failed_transcript_holds_for_review_and_retry_sends_only_it(self):
        async def window(segment, policy, config, key, **kwargs):
            return {'probabilities': LOW}

        async def broken(*args, **kwargs):
            raise httpx.ConnectError('down')
        first = self.run_models(configs=(JEV, LLM), evaluator=window, transcript_evaluator=broken, full_text=True)
        for provider in ('jev', 'openai'):
            text = first['providers'][provider]['transcript']
            self.assertEqual((text['status'], text['action'], text['error_type']), ('failed', 'review', 'ConnectError'))
            self.assertFalse(first['providers'][provider]['complete'])
        sent = []

        async def no_window(*args, **kwargs):
            raise AssertionError('windows are not re-sent')

        async def whole(sentences, policy, config, key, **kwargs):
            sent.append(config.provider)
            return {'probabilities': LOW, 'sentences': {}}
        # The JEV transcript is fixed by hand first: only the failed one (openai) is sent again.
        first['providers']['jev']['transcript'] = {'status': 'completed', 'action': 'allow', 'sentence_count': 4}
        retried = self.run_models(configs=(JEV, LLM), evaluator=no_window, transcript_evaluator=whole, full_text=True,
                                  only_segments={'jev': set(), 'openai': set()}, previous=first)
        self.assertEqual(sent, ['openai'])
        self.assertTrue(all(p['complete'] for p in retried['providers'].values()))
        self.assertEqual(retried['providers']['jev']['transcript']['status'], 'completed')

    def test_cancelling_is_not_recorded_as_a_failed_transcript(self):
        async def whole(*args, **kwargs):
            raise AssertionError('cancelled before sending')

        async def window(*args, **kwargs):
            return {'probabilities': LOW}
        flags = iter([False])                       # passes the first check, stops once the slot is taken
        with self.assertRaises(Cancelled):
            self.run_models(evaluator=window, transcript_evaluator=whole, full_text=True,
                            should_stop=lambda: next(flags, True))

    def test_a_transcript_block_does_not_stop_the_windows(self):
        sent = []

        async def window(segment, policy, config, key, **kwargs):
            sent.append(segment['segment_id'])
            return {'probabilities': LOW}

        async def whole(sentences, policy, config, key, **kwargs):
            return {'probabilities': {'violence': 0.95, 'hate': 0.1}, 'sentences': {'violence': [1]}}
        report = self.run_models(evaluator=window, transcript_evaluator=whole, limiters={'openai': Limiter(1)},
                                 full_text=True, stop_on_block=True)
        self.assertEqual(sorted(sent), [1, 2, 3, 4])
        self.assertEqual(report['providers']['openai']['transcript']['action'], 'block')

    def test_long_transcript_passages_are_merged(self):
        calls = []

        async def window(segment, policy, config, key, **kwargs):
            return {'probabilities': LOW}

        async def whole(sentences, policy, config, key, **kwargs):
            calls.append([s['id'] for s in sentences])
            hate = 0.9 if sentences[0]['id'] > 1 else 0.1
            return {'probabilities': {'violence': 0.1, 'hate': hate}, 'sentences': {'hate': [sentences[-1]['id']]},
                    'usage': {'total_tokens': 5}}
        original = pipeline.transcript_passages
        with patch.object(pipeline, 'transcript_passages', lambda s: original(s, max_chars=12, overlap=1)):
            report = self.run_models(evaluator=window, transcript_evaluator=whole, full_text=True)
        text = report['providers']['openai']['transcript']
        self.assertGreater(len(calls), 1)
        self.assertEqual(text['passages'], len(calls))
        self.assertEqual(text['probabilities']['hate'], 0.9)
        self.assertEqual(text['usage'], {'total_tokens': 5 * len(calls)})
        self.assertEqual(text['sentences']['hate'], sorted({c[-1] for c in calls}))


class DesktopSettingsTests(unittest.TestCase):
    def test_both_are_on_by_default_and_change_the_reuse_signature(self):
        self.assertEqual(desktop.semantics(desktop.default_settings()), {'full_text': True, 'speech_context': True})
        self.assertEqual(desktop.semantics({'full_text': False}), {'full_text': False, 'speech_context': True})

    def test_moderation_and_retry_pass_the_switches(self):
        with tempfile.TemporaryDirectory() as root:
            job, manifest = make_job(root)
            (job / 'inputs.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
            previous = {'input_hash': manifest['input_hash'], 'policy': POLICY, 'modality': 'text', 'full_text': True,
                        'speech_context': False, 'providers': {'jev': {'complete': False, 'segments': [],
                                                                       'transcript': {'status': 'failed'}}}}
            source = job / 'evaluation-old' / 'report.json'
            source.parent.mkdir()
            source.write_text(json.dumps(previous), encoding='utf-8')
            seen = []

            async def fake_run(manifest_arg, policy, configs, destination, **kwargs):
                seen.append(kwargs)
                return {'report_path': 'new', 'providers': {}}
            with patch.object(desktop, 'run_models', side_effect=fake_run), patch.dict(os.environ, {'TYPESAFE_API_KEY': 'k'}):
                desktop.start_evaluation(dict(job_id='r', report_path=str(source), retry_failed=True, settings={}),
                                         lambda *a, **k: None).join(5)
                desktop.start_evaluation(dict(job_id='s', report_path=str(source), provider='jev',
                                              settings={'full_text': False}),
                                         lambda *a, **k: None).join(5)
        self.assertEqual((seen[0]['full_text'], seen[0]['speech_context']), (True, False))   # as in the retried report
        self.assertEqual(seen[0]['only_segments'], {'jev': set()})
        self.assertEqual((seen[1]['full_text'], seen[1]['speech_context']), (False, True))   # current settings


if __name__ == '__main__':
    unittest.main()
