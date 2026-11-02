"""JSON-lines desktop transport. No UI, classroom pipeline, or model prompts here."""
import json
import sys
import threading

from .desktop import default_settings, start_moderation

_output_lock = threading.Lock()


def emit(event, **fields):
    with _output_lock:
        print(json.dumps({'type': event, **fields}, ensure_ascii=False), flush=True)


def main():
    jobs = []
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
            else:
                raise ValueError('Unsupported action')
        except (ValueError, TypeError, KeyError):
            emit('worker.error', error='无效的后台命令')
    for job in jobs:
        job.join()


if __name__ == '__main__':
    main()
