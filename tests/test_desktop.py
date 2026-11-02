import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from short_video_moderation.desktop import default_settings, start_moderation


class DesktopTests(unittest.TestCase):
    def test_worker_initializes_and_rejects_removed_workflows(self):
        commands = '\n'.join(json.dumps(c) for c in [
            {'action': 'initialize'}, {'action': 'start_classroom_job'}, []]) + '\n'
        result = subprocess.run([sys.executable, '-m', 'short_video_moderation.worker'],
                                input=commands, capture_output=True, text=True, encoding='utf-8',
                                env={**os.environ, 'PYTHONIOENCODING': 'utf-8'}, timeout=20, check=True)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual([e['type'] for e in events], ['worker.ready', 'worker.error', 'worker.error'])
        self.assertNotIn('llm_api_key', events[0]['settings'])
        self.assertIn('short-video-moderation', events[0]['settings']['output_root'])

    def test_upload_confirmation_is_required_before_preparation(self):
        events = []
        with patch('short_video_moderation.desktop.prepare') as prepare:
            thread = start_moderation({}, lambda event, **data: events.append((event, data)))
            thread.join(10)
            self.assertFalse(thread.is_alive())
            prepare.assert_not_called()
        self.assertEqual(events[-1][0], 'moderation.failed')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_independent_desktop_runs_both_providers_without_audio_or_old_repo(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, dict(self.headers), body))
                if self.path.endswith('/systemone'):
                    response = {'model': body['model'], 'answers': {
                        category: {'type': 'noul', 'noul': 0.1} for category in body['questions']}}
                else:
                    response = {'model': body['model'], 'choices': [{'message': {'content': json.dumps({
                        'probabilities': {'violence': 0.1, 'hate': 0.2, 'harassment': 0.3}})}}]}
                data = json.dumps(response).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        serving = threading.Thread(target=server.serve_forever, daemon=True)
        serving.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                video = root / 'silent.mp4'
                subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
                                '-i', 'color=c=blue:s=320x180:d=2:r=20', '-c:v', 'libx264', str(video)],
                               capture_output=True, check=True)
                url = f'http://127.0.0.1:{server.server_port}/v1'
                settings = {**default_settings(), 'jev_base_url': url, 'llm_base_url': url,
                            'llm_model': 'baseline', 'llm_api_key': 'baseline-test-key'}
                events = []
                with patch('short_video_moderation.desktop.transcription_config', side_effect=AssertionError('Silent video must not load ASR')):
                    thread = start_moderation(dict(video_path=str(video), output_root=str(root / 'results'),
                                                   settings=settings, provider='both', jev_key='jev-test-key',
                                                   interval=0.5, segment_seconds=0.5, upload_consent=True),
                                              lambda event, **data: events.append((event, data)))
                    thread.join(30)
                    self.assertFalse(thread.is_alive())
                self.assertEqual(events[-1][0], 'moderation.completed', events[-1])
                report = events[-1][1]['report']
                self.assertTrue(all(p['complete'] for p in report['providers'].values()))
                self.assertEqual(len(requests), 8)
                for provider in report['providers'].values():
                    self.assertTrue(all(r['end_sec'] - r['start_sec'] <= 0.5 for r in provider['segments']))
                report_text = Path(report['report_path']).read_text(encoding='utf-8')
                self.assertNotIn('test-key', report_text)
                jev_images = [list(body['assets'].values())[0]['data_base64'] for path, _, body in requests if path.endswith('/systemone')]
                baseline_images = [body['messages'][1]['content'][-1]['image_url']['url'].split(',')[1]
                                   for path, _, body in requests if path.endswith('/chat/completions')]
                self.assertEqual(jev_images, baseline_images)
        finally:
            server.shutdown()
            server.server_close()
            serving.join(5)


if __name__ == '__main__':
    unittest.main()
