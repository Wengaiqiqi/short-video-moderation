"""Application service used by the desktop JSON-line worker."""
import asyncio
import base64
import json
import os
import subprocess
import threading
import time
from importlib.resources import files
from pathlib import Path

from .media import FFmpegTools, _SUBPROCESS_KWARGS
from .paths import runtime_root
from .pipeline import prepare, run_models
from .providers import ProviderConfig
from .sampling import SamplingConfig
from .transcription import TranscriptionConfig

_lock = threading.Lock()
VIDEO_EXTENSIONS = ('.mp4', '.mkv', '.mov', '.webm')


def load_defaults():
    return json.loads(files('short_video_moderation').joinpath('defaults/moderation.json').read_text(encoding='utf-8'))


def default_settings():
    providers = {c['provider']: c for c in load_defaults()['providers']}
    return dict(output_root=str(runtime_root() / 'results'),
                jev_base_url=providers['jev']['base_url'], jev_model=providers['jev']['model'],
                llm_base_url=providers['openai']['base_url'], llm_model=providers['openai']['model'],
                asr_engine='faster-whisper', asr_model='small', asr_language='zh',
                asr_device='cpu', asr_compute_type='int8',
                mimo_base_url='https://api.xiaomimimo.com/v1', mimo_model='mimo-v2.5-asr',
                asr_concurrency=3, ffmpeg_path='', ffprobe_path='')


def transcription_config(settings):
    config = TranscriptionConfig(
        engine=settings['asr_engine'], model=settings.get('asr_model', 'small'),
        language=settings.get('asr_language') or None,
        device=settings.get('asr_device', 'cpu'), compute_type=settings.get('asr_compute_type', 'int8'),
        mimo_base_url=settings['mimo_base_url'], mimo_model=settings['mimo_model'],
        mimo_max_concurrency=int(settings.get('asr_concurrency', 3)),
        ffmpeg_path=settings.get('ffmpeg_path') or None,
    )
    config.validate()
    return config


def list_videos(directory):
    """Videos directly inside a folder (not recursive), sorted by name."""
    folder = Path(str(directory or '')).expanduser()
    if not folder.is_dir():
        raise FileNotFoundError(f'文件夹不存在：{folder}')
    return sorted((str(p) for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS),
                  key=lambda p: Path(p).name.lower())


def video_thumbnail(video, ffmpeg_path=None, width=192):
    """Cover image as a JPEG data URL; tries 1s in, then the first frame for very short clips."""
    ffmpeg = FFmpegTools._resolve(ffmpeg_path or None, 'ffmpeg')
    if not Path(video).is_file():
        raise FileNotFoundError(f'视频文件不存在：{video}')
    for offset in ('1', '0'):
        result = subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-ss', offset, '-i', str(video),
                                 '-frames:v', '1', '-vf', f'scale={int(width)}:-2', '-f', 'image2pipe',
                                 '-vcodec', 'mjpeg', '-q:v', '5', '-'],
                                capture_output=True, timeout=30, **_SUBPROCESS_KWARGS)
        if result.returncode == 0 and result.stdout:
            return 'data:image/jpeg;base64,' + base64.b64encode(result.stdout).decode('ascii')
    raise ValueError('无法读取视频封面')


def start_moderation(payload, emit):
    if not _lock.acquire(blocking=False):
        emit('moderation.rejected', error='已有审核任务正在运行，请等待完成。')
        return None

    def run():
        try:
            if not payload.get('upload_consent'):
                raise ValueError('请确认发送画面和转写文字；云端语音识别还会发送音频。')
            settings = {**default_settings(), **payload.get('settings', {})}
            selected = payload.get('provider', 'both')
            modality = payload.get('modality', 'multimodal')
            if selected not in ('both', 'jev', 'openai') or modality not in ('multimodal', 'visual', 'text'):
                raise ValueError('未知模型组或输入模态')
            providers = []
            if selected in ('both', 'jev'):
                providers.append(ProviderConfig('jev', settings['jev_base_url'], settings['jev_model'], 'TYPESAFE_API_KEY'))
            if selected in ('both', 'openai'):
                providers.append(ProviderConfig('openai', settings['llm_base_url'], settings['llm_model'], 'LLM_API_KEY'))
            keys = {'jev': str(payload.get('jev_key', '')).strip() or os.environ.get('TYPESAFE_API_KEY', ''),
                    'openai': str(settings.get('llm_api_key', '')).strip() or os.environ.get('LLM_API_KEY', '')}
            for provider in providers:
                provider.validate()
                if not keys[provider.provider]:
                    raise ValueError(f'请填写 {provider.provider} API Key，或设置 {provider.api_key_env}')
            output = str(payload.get('output_root', '')).strip()
            if not output:
                raise ValueError('请选择结果目录')
            destination = Path(output).resolve() / ('moderation-' + time.strftime('%Y%m%d-%H%M%S') + '-' + os.urandom(3).hex())
            progress = lambda message: emit('moderation.progress', message=message)
            manifest = prepare(
                payload['video_path'], destination,
                SamplingConfig(interval_sec=float(payload.get('interval', 0.5)),
                               segment_sec=float(payload.get('segment_seconds', 8))),
                lambda: transcription_config(settings),
                asr_key=settings.get('asr_api_key'), ffmpeg_path=settings.get('ffmpeg_path') or None,
                ffprobe_path=settings.get('ffprobe_path') or None, progress=progress,
            )
            report = asyncio.run(run_models(manifest, load_defaults()['policy'], providers, destination,
                                           keys=keys, modality=modality, progress=progress))
            emit('moderation.completed', message=report['report_path'], report=report, video_path=payload.get('video_path'))
        except Exception as error:
            # Do not relay network response bodies (which may echo credentials).
            message = str(error) if isinstance(error, (ValueError, FileNotFoundError)) else f'处理失败（{type(error).__name__}），请检查模型配置和视频后重试。'
            emit('moderation.failed', error=message, video_path=payload.get('video_path'))
        finally:
            _lock.release()

    thread = threading.Thread(target=run, daemon=True, name='moderation-job')
    thread.start()
    return thread
