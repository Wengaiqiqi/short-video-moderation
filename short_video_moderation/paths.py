"""Runtime paths, separate from the source checkout."""
import os
from pathlib import Path


def cache_root():
    default = Path('D:/Codex data/home/.cache') if os.name == 'nt' else Path.home() / '.cache'
    return Path(os.environ.get('SVM_CACHE_ROOT', default))


def runtime_root():
    default = Path('D:/Codex data/tmp/short-video-moderation') if os.name == 'nt' else cache_root() / 'short-video-moderation/runtime'
    return Path(os.environ.get('SVM_RUNTIME_ROOT', default))


def temp_root():
    path = runtime_root() / 'tmp'
    path.mkdir(parents=True, exist_ok=True)
    return path
