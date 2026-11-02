"""JSON-lines desktop transport. No UI, classroom pipeline, or model prompts here."""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from .desktop import default_settings, list_videos, start_moderation, video_thumbnail

_output_lock = threading.Lock()


def emit(event, **fields):
    with _output_lock:
        print(json.dumps({'type': event, **fields}, ensure_ascii=False), flush=True)


def _thumbnail(payload):
    item = payload.get('id')
    try:
        emit('video.thumbnail', id=item, data_url=video_thumbnail(payload['video_path'], payload.get('ffmpeg_path')))
    except Exception as error:
        # Covers are cosmetic: report the failure without details from FFmpeg.
        emit('video.thumbnail', id=item, error=str(error) if isinstance(error, (ValueError, FileNotFoundError)) else '无法读取视频封面')


def main():
    jobs = []
    covers = ThreadPoolExecutor(max_workers=2, thread_name_prefix='thumbnail')
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError('Command must be an object')
            action = command.get('action')
            if action == 'initialize':
                emit('worker.ready', settings=default_settings())
            elif action == 'moderation_start':
                payload = command.get('payload')
                if not isinstance(payload, dict):
                    raise ValueError('Task payload must be an object')
                thread = start_moderation(payload, emit)
                jobs = [job for job in jobs if job.is_alive()]
                if thread:
                    jobs.append(thread)
            elif action == 'thumbnail':
                payload = command.get('payload')
                if not isinstance(payload, dict) or not isinstance(payload.get('video_path'), str):
                    raise ValueError('Thumbnail payload must name a video')
                covers.submit(_thumbnail, payload)
            elif action == 'list_videos':
                payload = command.get('payload')
                if not isinstance(payload, dict):
                    raise ValueError('Folder payload must be an object')
                try:
                    emit('videos.listed', directory=payload.get('directory'), videos=list_videos(payload.get('directory')))
                except (OSError, ValueError) as error:
                    emit('videos.listed', directory=payload.get('directory'), videos=[],
                         error=str(error) if isinstance(error, FileNotFoundError) else '无法读取文件夹')
            else:
                raise ValueError('Unsupported action')
        except (ValueError, TypeError, KeyError):
            emit('worker.error', error='无效的后台命令')
    covers.shutdown(wait=True)
    for job in jobs:
        job.join()


if __name__ == '__main__':
    main()
