"""JSON-lines desktop transport. No UI, classroom pipeline, or model prompts here."""
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from .desktop import (cancel_jobs, initial_settings, list_videos, start_evaluation, start_moderation,
                      video_thumbnail)
from .errors import UserFacingError
from .evidence import probe_duration, segment_clip, segment_evidence, split_video
from .library import export_csv, list_history, reveal_report, save_review, save_settings

_output_lock = threading.Lock()


def emit(event, **fields):
    with _output_lock:
        print(json.dumps({'type': event, **fields}, ensure_ascii=False), flush=True)


def _message(error, fallback):
    return str(error) if isinstance(error, (ValueError, FileNotFoundError, UserFacingError)) else fallback


def _thumbnail(payload):
    item = payload.get('id')
    fields = {}
    try:
        fields['duration_sec'] = probe_duration(payload['video_path'], ffmpeg_path=payload.get('ffmpeg_path'),
                                                ffprobe_path=payload.get('ffprobe_path'))
    except Exception:
        pass
    try:
        emit('video.thumbnail', id=item, data_url=video_thumbnail(payload['video_path'], payload.get('ffmpeg_path')), **fields)
    except Exception as error:
        # Covers are cosmetic: report the failure without details from FFmpeg.
        emit('video.thumbnail', id=item, error=_message(error, '无法读取视频封面'), **fields)


def _tool(event, request, function, fallback):
    """Run a request/response helper and reply with the same request_id."""
    def run():
        try:
            emit(event, request_id=request, **function())
        except Exception as error:
            emit(event, request_id=request, error=_message(error, fallback))
    return run


def main():
    jobs = []
    tools = ThreadPoolExecutor(max_workers=4, thread_name_prefix='worker-tool')
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError('Command must be an object')
            action = command.get('action')
            payload = command.get('payload') if isinstance(command.get('payload'), dict) else {}
            request = payload.get('request_id')
            if action == 'initialize':
                emit('worker.ready', settings=initial_settings())
            elif action in ('moderation_start', 'moderation_evaluate'):
                if not isinstance(command.get('payload'), dict):
                    raise ValueError('Task payload must be an object')
                thread = (start_moderation if action == 'moderation_start' else start_evaluation)(payload, emit)
                jobs = [job for job in jobs if job.is_alive()]
                if thread:
                    jobs.append(thread)
            elif action == 'moderation_cancel':
                emit('moderation.cancel_requested', job_id=payload.get('job_id'), count=cancel_jobs(payload.get('job_id')))
            elif action == 'thumbnail':
                if not isinstance(payload.get('video_path'), str):
                    raise ValueError('Thumbnail payload must name a video')
                tools.submit(_thumbnail, payload)
            elif action == 'list_videos':
                try:
                    emit('videos.listed', directory=payload.get('directory'), videos=list_videos(payload.get('directory')))
                except (OSError, ValueError) as error:
                    emit('videos.listed', directory=payload.get('directory'), videos=[],
                         error=str(error) if isinstance(error, FileNotFoundError) else '无法读取文件夹')
            elif action == 'segment_evidence':
                tools.submit(_tool('segment.evidence', request, lambda p=payload: segment_evidence(
                    p['report_path'], p['segment_id']), '无法读取片段证据'))
            elif action == 'segment_clip':
                def clip(p=payload):
                    mime, data = segment_clip(p['video_path'], p['start_sec'], p['end_sec'], ffmpeg_path=p.get('ffmpeg_path'))
                    return {'mime': mime, 'data': data}
                tools.submit(_tool('segment.clip', request, clip, '无法生成片段视频'))
            elif action == 'save_review':
                tools.submit(_tool('review.saved', request, lambda p=payload: {
                    'report_path': p.get('report_path'),
                    'review': save_review(p.get('report_path'), p.get('decision'), p.get('note', ''))}, '无法保存人工终判'))
            elif action == 'list_history':
                tools.submit(_tool('history.loaded', request, lambda p=payload: {
                    'entries': list_history(p.get('output_root'), int(p.get('limit') or 300))}, '无法读取历史结果'))
            elif action == 'save_settings':
                tools.submit(_tool('settings.saved', request, lambda p=payload: {
                    'stored_keys': save_settings(p.get('settings'))}, '无法保存设置'))
            elif action == 'export_csv':
                tools.submit(_tool('export.done', request, lambda p=payload: {
                    'path': export_csv(p.get('path'), p.get('rows'))}, '导出失败'))
            elif action == 'reveal_report':
                tools.submit(_tool('report.revealed', request, lambda p=payload: {'path': reveal_report(p.get('report_path'))},
                                   '无法打开报告所在文件夹'))
            elif action == 'split_video':
                tools.submit(_tool('video.split', request, lambda p=payload: {
                    'id': p.get('id'), 'parts': split_video(p['video_path'], part_sec=float(p.get('part_sec') or 590),
                                                            ffmpeg_path=p.get('ffmpeg_path'), ffprobe_path=p.get('ffprobe_path'))},
                    '长视频切分失败'))
            else:
                raise ValueError('Unsupported action')
        except (ValueError, TypeError, KeyError):
            emit('worker.error', error='无效的后台命令')
    tools.shutdown(wait=True)
    for job in jobs:
        job.join()


if __name__ == '__main__':
    main()
