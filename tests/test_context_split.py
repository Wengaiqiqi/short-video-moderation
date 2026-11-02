import asyncio
import copy
import json
import tempfile
import unittest
from pathlib import Path

import httpx

from short_video_moderation.providers import ProviderConfig, ModelRequestError, evaluate, evaluate_transcript


class ContextSplitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.image = Path(self.temp.name) / 'frame.jpg'
        self.image.write_bytes(b'image-bytes')
        self.segment = {'start_sec': 0, 'end_sec': 8, 'frames': [
            {'time_sec': i / 2, 'path': str(self.image)} for i in range(16)],
            'speech_text': 'complete context', 'utterances': [{'start_sec': 0, 'end_sec': 8, 'text': 'speech'}],
            'speech_context': {'before': 'before', 'after': 'after'}}
        self.policy = {'categories': {'hate': {'question': 'q', 'positive': 'yes', 'negative': 'no'}}}
        self.config = ProviderConfig('jev', 'https://example.test/v1', 'jev', 'TEST', max_attempts=1)

    def run_eval(self, handler, **kwargs):
        return asyncio.run(evaluate(self.segment, self.policy, self.config, 'test-key',
                                   transport=httpx.MockTransport(handler), **kwargs))

    def success(self, score=.2):
        return httpx.Response(200, json={'answers': {'hate': {'type': 'noul', 'noul': score}},
                                      'usage': {'input_tokens': 10, 'output_tokens': 2}})

    def overflow(self):
        return httpx.Response(400, json={'detail': {'error_type': 'max_tokens_exceeded'}})

    def test_recursive_split_preserves_context_frames_and_usage(self):
        original = copy.deepcopy(self.segment)
        leaves, calls, keys = [], [], []
        def handler(request):
            data = json.loads(request.content); state = data['state']
            times = [f['time_sec'] for f in state['frames']]
            calls.append(len(times)); keys.append(request.headers['Idempotency-Key'])
            self.assertEqual(state['speech_text'], self.segment['speech_text'])
            self.assertEqual(state['speech_intervals'], self.segment['utterances'])
            self.assertEqual((state['start_sec'], state['end_sec']), (0, 8))
            self.assertEqual((state['context_before'], state['context_after']), ('before', 'after'))
            self.assertEqual(len(data['assets']), len(times))
            if len(times) > 4:
                return self.overflow()
            leaves.extend(times)
            return self.success(.9 if 6 in times else .2)
        result = self.run_eval(handler)
        self.assertEqual(calls, [16, 8, 4, 4, 8, 4, 4])
        self.assertEqual(leaves, [i / 2 for i in range(16)])
        self.assertEqual(len(set(keys)), len(keys))
        self.assertEqual(result['probabilities'], {'hate': .9})
        self.assertEqual(result['usage'], {'input_tokens': 40, 'output_tokens': 8})
        self.assertEqual(len(result['context_split']['successful_batches']), 4)
        self.assertEqual(self.segment, original)

    def test_other_errors_never_split(self):
        for status, body in [(400, {'error': {'code': 'invalid_request'}}),
                             (401, {'detail': {'error_type': 'max_tokens_exceeded'}}),
                             (400, {'message': 'example max_tokens_exceeded'})]:
            calls = []
            def handler(request):
                calls.append(request)
                return httpx.Response(status, json=body)
            with self.assertRaises(ModelRequestError) as ctx:
                self.run_eval(handler)
            self.assertEqual(ctx.exception.code, f'http_{status}')
            self.assertEqual(len(calls), 1)

    def test_single_image_limit_stops_and_does_not_return_partial_success(self):
        self.segment['frames'] = self.segment['frames'][:2]
        def handler(request):
            frames = json.loads(request.content)['state']['frames']
            return self.success() if len(frames) == 1 and frames[0]['time_sec'] == 0 else self.overflow()
        with self.assertRaises(ModelRequestError) as ctx:
            self.run_eval(handler)
        self.assertEqual(ctx.exception.code, 'max_tokens_exceeded')
        self.assertEqual(len(ctx.exception.context_split['successful_batches']), 1)

    def test_text_only_and_full_transcript_do_not_split_images(self):
        calls = []
        def handler(request):
            calls.append(request)
            return self.overflow()
        with self.assertRaises(ModelRequestError):
            self.run_eval(handler, modality='text')
        self.assertEqual(len(calls), 1)
        with self.assertRaises(ModelRequestError):
            asyncio.run(evaluate_transcript([{'id': 1, 'start_sec': 0, 'end_sec': 1, 'text': 'hello'}],
                self.policy, self.config, 'test-key', transport=httpx.MockTransport(handler)))
        self.assertEqual(len(calls), 2)

    def test_control_provider_does_not_change(self):
        self.config = ProviderConfig('openai', 'https://example.test/v1', 'control', 'TEST', max_attempts=1)
        with self.assertRaises(ModelRequestError) as ctx:
            self.run_eval(lambda request: self.overflow())
        self.assertEqual(ctx.exception.code, 'http_400')

    def test_successful_request_unchanged(self):
        result = self.run_eval(lambda request: self.success())
        self.assertEqual(result['probabilities'], {'hate': .2})
        self.assertNotIn('context_split', result)


if __name__ == '__main__':
    unittest.main()
