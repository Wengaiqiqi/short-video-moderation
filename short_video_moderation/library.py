"""Results on disk: history, human review decisions, the reviewed-video index, saved settings and exports."""
from __future__ import annotations

import csv
import hashlib
import json
import os
import threading
import time
from pathlib import Path

from .paths import runtime_root

SECRET_KEYS = {'jev_api_key': 'jev', 'llm_api_key': 'openai', 'asr_api_key': 'asr'}
KEYRING_SERVICE = 'short-video-moderation'
DECISIONS = ('allow', 'block', 'review')
_index_lock = threading.Lock()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


def job_dir(report_path):
    """The moderation-* folder of a report (…/moderation-*/evaluation-*/report.json)."""
    report = Path(str(report_path)).resolve()
    if report.name != 'report.json' or not report.parent.name.startswith('evaluation-') \
            or not report.parent.parent.name.startswith('moderation-'):
        raise ValueError('不是审核报告路径')
    return report.parent.parent


# ── Human review ────────────────────────────────────────────────────────────

def save_review(report_path, decision, note=''):
    """Record (or clear, with decision=None) the reviewer's final decision for one video."""
    target = job_dir(report_path) / 'review.json'
    if decision is None:
        target.unlink(missing_ok=True)
        return None
    if decision not in DECISIONS:
        raise ValueError('人工终判只能是通过、拦截或待定')
    data = {'decision': decision, 'note': str(note or '')[:500], 'at': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'report_path': Path(report_path).as_posix()}
    write_json_atomic(target, data)
    return data


def load_review(job):
    path = Path(job) / 'review.json'
    try:
        return read_json(path) if path.is_file() else None
    except (OSError, ValueError):
        return None


# ── History ────────────────────────────────────────────────────────────────

def list_history(output_root, limit=300):
    """Latest report of each reviewed video under the results folder, newest first."""
    root = Path(str(output_root or '')).expanduser()
    if not root.is_dir():
        return []
    jobs = [d for d in root.iterdir() if d.is_dir() and d.name.startswith('moderation-')]
    jobs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
    entries = []
    for job in jobs:
        runs = list(job.glob('evaluation-*/report.json'))
        if not runs:
            continue
        latest = max(runs, key=lambda p: p.stat().st_mtime)
        try:
            report = read_json(latest)
            if not report.get('video_path') and (job / 'inputs.json').is_file():
                inputs = read_json(job / 'inputs.json')
                report['video_path'] = inputs.get('video_path')
                report['duration_sec'] = inputs.get('duration_sec')
        except (OSError, ValueError):
            continue
        report['report_path'] = latest.as_posix()
        entries.append({'report': report, 'review': load_review(job), 'runs': len(runs),
                        'finished_at': int(latest.stat().st_mtime * 1000)})
        if len(entries) >= limit:
            break
    return entries


# ── Reviewed-video index: skip videos already reviewed with the same configuration ──

def video_fingerprint(path, chunk=4 * 1024 * 1024):
    """Content fingerprint: file size plus the first and last 4 MiB (fast even for large files)."""
    path = Path(path)
    size = path.stat().st_size
    digest = hashlib.sha256(str(size).encode())
    with path.open('rb') as source:
        digest.update(source.read(chunk))
        if size > chunk:
            source.seek(max(chunk, size - chunk))
            digest.update(source.read(chunk))
    return digest.hexdigest()


def run_signature(**parts):
    """Everything that changes a result: policy, models, modality, sampling and ASR settings."""
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _index_path(output_root):
    return Path(output_root) / 'index.json'


def find_reviewed(output_root, video_fp, signature):
    """A complete earlier report for the same file and configuration, or None."""
    try:
        index = read_json(_index_path(output_root))
    except (OSError, ValueError):
        return None
    for entry in reversed(index.get(video_fp, [])):
        if entry.get('signature') != signature:
            continue
        path = Path(entry.get('report_path', ''))
        try:
            report = read_json(path)
        except (OSError, ValueError):
            continue
        if report.get('providers') and all(p.get('complete') for p in report['providers'].values()):
            report['report_path'] = path.as_posix()
            return report
    return None


def remember_reviewed(output_root, video_fp, signature, report_path):
    with _index_lock:
        try:
            index = read_json(_index_path(output_root))
        except (OSError, ValueError):
            index = {}
        entries = [e for e in index.get(video_fp, []) if e.get('signature') != signature]
        entries.append({'signature': signature, 'report_path': Path(report_path).as_posix(),
                        'at': time.strftime('%Y-%m-%dT%H:%M:%S')})
        index[video_fp] = entries[-5:]
        write_json_atomic(_index_path(output_root), index)


# ── Settings and keys ───────────────────────────────────────────────────────

def settings_path():
    return runtime_root() / 'settings.json'


def load_saved_settings():
    try:
        saved = read_json(settings_path())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in saved.items() if k not in SECRET_KEYS} if isinstance(saved, dict) else {}


def _keyring():
    try:
        import keyring
        from keyring.backends import fail
    except Exception:
        return None
    try:
        return None if isinstance(keyring.get_keyring(), fail.Keyring) else keyring
    except Exception:
        return None


def keychain_available():
    return _keyring() is not None


def stored_key(name):
    """A key saved in the system keychain ('jev', 'openai' or 'asr'), or ''."""
    ring = _keyring()
    if ring is None:
        return ''
    try:
        return ring.get_password(KEYRING_SERVICE, name) or ''
    except Exception:
        return ''


def stored_key_flags():
    return {name: bool(stored_key(name)) for name in SECRET_KEYS.values()}


def save_settings(settings):
    """Save settings without keys. With remember_keys, keys typed in go to the system keychain."""
    if not isinstance(settings, dict):
        raise ValueError('设置格式无效')
    clean = {k: v for k, v in settings.items() if k not in SECRET_KEYS}
    write_json_atomic(settings_path(), clean)
    ring = _keyring()
    if ring is not None:
        for field, name in SECRET_KEYS.items():
            value = str(settings.get(field) or '').strip()
            try:
                if not settings.get('remember_keys'):
                    if ring.get_password(KEYRING_SERVICE, name):
                        ring.delete_password(KEYRING_SERVICE, name)
                elif value:
                    ring.set_password(KEYRING_SERVICE, name, value)
            except Exception:
                pass
    return stored_key_flags()


# ── Show a report in the file manager ───────────────────────────────────────

def reveal_command(path, platform=None):
    """Command that opens the file manager with the report selected (Windows, macOS) or its folder (Linux)."""
    import sys
    platform = platform or sys.platform
    target = os.path.normpath(str(path))
    if platform == 'win32':
        # explorer wants /select,"path" as written; its exit code is 1 even on success.
        return f'explorer /select,"{target}"'
    if platform == 'darwin':
        return ['open', '-R', target]
    return ['xdg-open', os.path.dirname(target)]


def reveal_report(report_path):
    """Open the folder of a review report with report.json selected. Only paths inside a review job are accepted."""
    import subprocess
    job_dir(report_path)  # rejects anything that is not …/moderation-*/evaluation-*/report.json
    report = Path(str(report_path)).resolve()
    if not report.is_file():
        raise FileNotFoundError(f'报告文件不存在：{report}')
    subprocess.Popen(reveal_command(report), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return report.as_posix()


# ── Labels for threshold calibration ────────────────────────────────────────

LABEL_WORDS = {'拦截': True, 'block': True, '1': True, '违规': True, 'true': True,
               '通过': False, 'allow': False, '0': False, '正常': False, 'false': False}


def read_labels(path):
    """Read a labelled CSV (video file name or path, label) into [{'name', 'blocked'}].

    Labels: 拦截/block/违规/1 → blocked; 通过/allow/正常/0 → not blocked. A header row is skipped.
    """
    source = Path(str(path or '')).expanduser()
    if source.suffix.lower() != '.csv' or not source.is_file():
        raise ValueError('请选择 .csv 标注文件')
    labels = []
    with source.open(encoding='utf-8-sig', newline='') as handle:
        for row in csv.reader(handle):
            if len(row) < 2:
                continue
            value = LABEL_WORDS.get(row[1].strip().lower())
            if value is None:
                continue  # header or unknown label
            labels.append({'name': Path(row[0].strip().replace('\\', '/')).name, 'blocked': value})
    if not labels:
        raise ValueError('标注文件中没有可识别的「文件名, 标签」行')
    return labels


# ── Export ──────────────────────────────────────────────────────────────────

def export_csv(path, rows):
    """Write rows as CSV with a UTF-8 BOM so Excel opens Chinese text correctly."""
    target = Path(str(path or '')).expanduser()
    if target.suffix.lower() != '.csv':
        raise ValueError('导出文件需要以 .csv 结尾')
    if not isinstance(rows, list) or not all(isinstance(r, list) for r in rows):
        raise ValueError('导出数据格式无效')
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle)
        for row in rows:
            writer.writerow(['' if cell is None else cell for cell in row])
    return target.as_posix()
