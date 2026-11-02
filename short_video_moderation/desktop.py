"""Application service used by the desktop JSON-line worker."""
import asyncio
import base64
import copy
import json
import os
import subprocess
import threading
import time
from importlib.resources import files
from pathlib import Path

from .errors import Cancelled, UserFacingError
from .library import (find_reviewed, job_dir, keychain_available, load_saved_settings, read_json, remember_reviewed,
                      run_signature, stored_key, stored_key_flags, video_fingerprint)
from .limits import ASR_REQUESTS, MODEL_REQUESTS
from .media import FFmpegTools, _SUBPROCESS_KWARGS
from .paths import runtime_root
from .pipeline import fingerprint, prepare, run_models, validate_policy
from .providers import ProviderConfig
from .sampling import SamplingConfig
from .transcription import TranscriptionConfig

_jobs_lock = threading.Lock()
_jobs: dict = {}  # job id → cancel event
# Hard ceiling on simultaneous videos in one worker; the UI chooses how many it starts (default 11).
MAX_PARALLEL_VIDEOS = 32
VIDEO_EXTENSIONS = ('.mp4', '.mkv', '.mov', '.webm')
PROVIDER_KEYS = {'jev': ('jev_api_key', 'TYPESAFE_API_KEY'), 'openai': ('llm_api_key', 'LLM_API_KEY')}


def load_defaults():
    return json.loads(files('short_video_moderation').joinpath('defaults/moderation.json').read_text(encoding='utf-8'))


def category_presets():
    return json.loads(files('short_video_moderation').joinpath('defaults/categories.json').read_text(encoding='utf-8'))


def default_settings():
    defaults = load_defaults()
    providers = {c['provider']: c for c in defaults['providers']}
    return dict(output_root=str(runtime_root() / 'results'),
                jev_base_url=providers['jev']['base_url'], jev_model=providers['jev']['model'],
                llm_base_url=providers['openai']['base_url'], llm_model=providers['openai']['model'],
                asr_engine='mimo-cloud', asr_model='small', asr_language='zh',
                asr_device='cpu', asr_compute_type='int8',
                mimo_base_url='https://api.xiaomimimo.com/v1', mimo_model='mimo-v2.5-asr',
                # Request limits are shared by all videos running at the same time.
                asr_concurrency=8, model_concurrency=8, video_concurrency=11,
                skip_reviewed=True, stop_on_block=False, remember_keys=False, split_long_videos=True,
                # Optional prices for the cost estimate: per million tokens, per audio minute.
                jev_price_per_mtok=0, llm_price_per_mtok=0, asr_price_per_min=0,
                policy=defaults['policy'], ffmpeg_path='', ffprobe_path='')


def initial_settings():
    """Defaults, overlaid with the settings saved last time (never keys), plus keychain status."""
    settings = {**default_settings(), **load_saved_settings()}
    try:
        validate_policy(settings['policy'])
    except (KeyError, TypeError, ValueError):
        settings['policy'] = load_defaults()['policy']
    return dict(settings, category_presets=category_presets(), keychain_available=keychain_available(),
                stored_keys=stored_key_flags())


def transcription_config(settings):
    config = TranscriptionConfig(
        engine=settings['asr_engine'], model=settings.get('asr_model', 'small'),
        language=settings.get('asr_language') or None,
        device=settings.get('asr_device', 'cpu'), compute_type=settings.get('asr_compute_type', 'int8'),
        mimo_base_url=settings['mimo_base_url'], mimo_model=settings['mimo_model'],
        mimo_max_concurrency=_bounded(settings.get('asr_concurrency'), 1, 10, 3),
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


def _bounded(value, low, high, default):
    try:
        return min(high, max(low, int(value)))
    except (TypeError, ValueError):
        return default


def resolve_policy(settings):
    """The policy edited in the UI when it is valid; otherwise the bundled default."""
    policy = settings.get('policy')
    if isinstance(policy, dict):
        policy = copy.deepcopy(policy)
        policy['categories'] = {k: v for k, v in policy.get('categories', {}).items() if v.get('enabled', True)}
        for rule in policy['categories'].values():
            rule.pop('enabled', None)
        validate_policy(policy)
        return policy
    return load_defaults()['policy']


def _context(payload, provider_choice=None):
    """Settings, provider configs, keys and policy for one job; also applies the shared request limits."""
    settings = {**default_settings(), **payload.get('settings', {})}
    ASR_REQUESTS.set_limit(_bounded(settings.get('asr_concurrency'), 1, 32, 8))
    for limiter in MODEL_REQUESTS.values():
        limiter.set_limit(_bounded(settings.get('model_concurrency'), 1, 64, 8))
    selected = provider_choice or payload.get('provider', 'both')
    modality = payload.get('modality', 'multimodal')
    if selected not in ('both', 'jev', 'openai') or modality not in ('multimodal', 'visual', 'text'):
        raise ValueError('未知模型组或输入模态')
    providers = []
    if selected in ('both', 'jev'):
        providers.append(ProviderConfig('jev', settings['jev_base_url'], settings['jev_model'], 'TYPESAFE_API_KEY'))
    if selected in ('both', 'openai'):
        providers.append(ProviderConfig('openai', settings['llm_base_url'], settings['llm_model'], 'LLM_API_KEY'))
    # Key order: typed in this window → system keychain → environment variable.
    keys = {'jev': str(payload.get('jev_key', '')).strip() or stored_key('jev') or os.environ.get('TYPESAFE_API_KEY', ''),
            'openai': str(settings.get('llm_api_key', '')).strip() or stored_key('openai') or os.environ.get('LLM_API_KEY', '')}
    for provider in providers:
        provider.validate()
        if not keys[provider.provider]:
            raise ValueError(f'请填写 {provider.provider} API Key，或设置 {provider.api_key_env}')
    asr_key = str(settings.get('asr_api_key') or '').strip() or stored_key('asr') or None
    return dict(settings=settings, providers=providers, keys=keys, modality=modality, policy=resolve_policy(settings),
                asr_key=asr_key)


def _run_job(payload, emit, work):
    """Run one video's job in a thread; several may run at once. Every event carries job_id."""
    job = payload.get('job_id') or os.urandom(4).hex()
    video_path = payload.get('video_path')

    def send(event, **fields):
        emit(event, job_id=payload.get('job_id'), video_path=video_path, **fields)

    stop = threading.Event()
    with _jobs_lock:
        if len(_jobs) >= MAX_PARALLEL_VIDEOS:
            send('moderation.rejected', error=f'同时审核的视频已达上限（{MAX_PARALLEL_VIDEOS} 个），请稍后。')
            return None
        _jobs[job] = stop

    def run():
        try:
            work(send, stop.is_set)
        except Cancelled:
            send('moderation.cancelled', error='已取消')
        except Exception as error:
            # UserFacingError messages are written to be shown; other errors may carry response bodies.
            safe = isinstance(error, (ValueError, FileNotFoundError, UserFacingError))
            message = str(error) if safe else f'处理失败（{type(error).__name__}），请检查模型配置和视频后重试。'
            send('moderation.failed', error=message)
        finally:
            with _jobs_lock:
                _jobs.pop(job, None)

    thread = threading.Thread(target=run, daemon=True, name='moderation-job')
    thread.start()
    return thread


def cancel_jobs(job_id=None):
    """Cancel one running video, or all of them when job_id is None. Returns how many were signalled."""
    with _jobs_lock:
        targets = [event for key, event in _jobs.items() if job_id is None or key == job_id]
    for event in targets:
        event.set()
    return len(targets)


def start_moderation(payload, emit):
    """Prepare a video and judge it. With skip_reviewed, an identical earlier review is reused."""
    def work(send, stopped):
        if not payload.get('upload_consent'):
            raise ValueError('请确认发送画面和转写文字；云端语音识别还会发送音频。')
        ctx = _context(payload)
        settings = ctx['settings']
        output = str(payload.get('output_root', '')).strip()
        if not output:
            raise ValueError('请选择结果目录')
        sampling = SamplingConfig(interval_sec=float(payload.get('interval', 0.5)),
                                  segment_sec=float(payload.get('segment_seconds', 8)))
        video_fp = signature = None
        if settings.get('skip_reviewed'):
            video_fp = video_fingerprint(payload['video_path'])
            signature = run_signature(
                policy=fingerprint(ctx['policy']), modality=ctx['modality'], sampling=sampling.__dict__,
                providers=[(p.provider, p.base_url, p.model) for p in ctx['providers']],
                asr=[settings.get('asr_engine'), settings.get('mimo_model') if settings.get('asr_engine') == 'mimo-cloud'
                     else settings.get('asr_model')])
            earlier = find_reviewed(Path(output).resolve(), video_fp, signature)
            if earlier is not None:
                send('moderation.completed', message=earlier['report_path'], report=earlier, cached=True)
                return
        destination = Path(output).resolve() / ('moderation-' + time.strftime('%Y%m%d-%H%M%S') + '-' + os.urandom(3).hex())
        progress = lambda message: send('moderation.progress', message=message)
        manifest = prepare(
            payload['video_path'], destination, sampling, lambda: transcription_config(settings),
            asr_key=ctx['asr_key'], ffmpeg_path=settings.get('ffmpeg_path') or None,
            ffprobe_path=settings.get('ffprobe_path') or None, progress=progress, asr_limiter=ASR_REQUESTS,
            should_stop=stopped,
        )
        report = asyncio.run(run_models(manifest, ctx['policy'], ctx['providers'], destination, keys=ctx['keys'],
                                        modality=ctx['modality'], progress=progress, limiters=MODEL_REQUESTS,
                                        should_stop=stopped, stop_on_block=bool(settings.get('stop_on_block'))))
        if video_fp and all(p['complete'] for p in report['providers'].values()):
            remember_reviewed(Path(output).resolve(), video_fp, signature, report['report_path'])
        send('moderation.completed', message=report['report_path'], report=report)

    return _run_job(payload, emit, work)


def start_evaluation(payload, emit):
    """Judge already prepared inputs again — no frame sampling or ASR.

    retry_failed=True re-sends only the windows that failed in report_path (same models, modality and
    policy) and merges them into a new report. Otherwise all windows are judged with the chosen
    provider group and modality.
    """
    def work(send, stopped):
        source = payload.get('report_path')
        job = job_dir(source)
        manifest = read_json(job / 'inputs.json')
        previous = read_json(source)
        previous['report_path'] = Path(source).as_posix()
        progress = lambda message: send('moderation.progress', message=message)
        progress('复用已准备的画面与转写')
        if payload.get('retry_failed'):
            present = list(previous.get('providers', {}))
            choice = 'both' if len(present) > 1 else (present[0] if present else 'both')
            ctx = _context(dict(payload, modality=previous.get('modality', 'multimodal')), choice)
            only = {p: {r['segment_id'] for r in previous['providers'][p]['segments'] if r.get('status') == 'failed'}
                    for p in present}
            report = asyncio.run(run_models(manifest, previous['policy'], ctx['providers'], job, keys=ctx['keys'],
                                            modality=ctx['modality'], progress=progress, limiters=MODEL_REQUESTS,
                                            should_stop=stopped, only_segments=only, previous=previous))
        else:
            ctx = _context(payload)
            report = asyncio.run(run_models(manifest, ctx['policy'], ctx['providers'], job, keys=ctx['keys'],
                                            modality=ctx['modality'], progress=progress, limiters=MODEL_REQUESTS,
                                            should_stop=stopped,
                                            stop_on_block=bool(ctx['settings'].get('stop_on_block'))))
        send('moderation.completed', message=report['report_path'], report=report)

    return _run_job(payload, emit, work)
