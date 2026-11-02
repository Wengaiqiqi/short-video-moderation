"""Blind binary test of the desktop app on MultiHateClip videos: JEV only, frames + speech.

Each video goes through desktop.start_moderation exactly as the app runs it, with the settings saved by the
app (rules, thresholds, full-text judgement, speech context). The model sees only the video: no title,
official transcript or label. The app's video verdict is mapped to the dataset's binary label:
allow -> Normal; review (待定) or block -> Harmful. A job that fails ends up in 待定 in the app, so it
also counts as Harmful; failures are reported separately.

  python scripts/blind_test_jev.py --selection <selection.json> --runtime <dir> --output <dir> [--concurrency 4]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import random
import shutil
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SEVERITY = {'allow': 0, 'review': 1, 'block': 2}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def video_verdict(provider):
    """The app's rule (desktop/src/lib/report.ts videoVerdict) for one provider's results."""
    windows = 'allow'
    for row in provider['segments']:
        action = 'allow' if row['status'] == 'skipped' else row.get('action', 'review') if row['status'] == 'completed' else 'review'
        windows = max(windows, action, key=SEVERITY.get)
    text = provider.get('transcript')
    text = None if not text else 'allow' if text['status'] == 'skipped' else text.get('action', 'review') if text['status'] == 'completed' else 'review'
    if not text or text == 'allow':
        return windows, windows
    return windows, 'review' if windows == 'allow' else max(windows, text, key=SEVERITY.get)


def metrics(rows):
    y = [r['gold'] != 'Normal' for r in rows]
    p = [r['predicted_harmful'] for r in rows]
    tp = sum(a and b for a, b in zip(y, p)); tn = sum(not a and not b for a, b in zip(y, p))
    fp = sum(not a and b for a, b in zip(y, p)); fn = sum(a and not b for a, b in zip(y, p))
    f1 = lambda t, x, z: 2 * t / (2 * t + x + z) if 2 * t + x + z else 0.0
    out = {'n': len(rows), 'accuracy': (tp + tn) / len(rows) if rows else None,
           'macro_f1': (f1(tp, fp, fn) + f1(tn, fn, fp)) / 2 if rows else None,
           'harmful': tp + fn, 'harmful_caught': tp, 'harmful_missed': fn, 'normal_passed': tn, 'normal_flagged': fp}
    if rows:
        rng = random.Random(20261103)
        accs = sorted(sum((rows[i]['gold'] != 'Normal') == rows[i]['predicted_harmful'] for i in draw) / len(rows)
                      for draw in ([rng.randrange(len(rows)) for _ in rows] for _ in range(5000)))
        out['accuracy_ci95'] = [accs[124], accs[4874]]
    return out


def summarize(args, selection, settings_info):
    rows = sorted((read(p) for p in (args.output / 'results').glob('*.json')), key=lambda r: r['index'])
    result = {'updated_at': now(), 'selected': len(selection), 'processed': len(rows), 'settings': settings_info,
              'overall': metrics(rows), 'by_language': {l: metrics([r for r in rows if r['language'] == l]) for l in ('Chinese', 'English')},
              'verdicts': {v: sum(r['verdict'] == v for r in rows) for v in ('allow', 'review', 'block', 'failed')},
              'job_failures': sum(r['verdict'] == 'failed' for r in rows),
              'videos_with_failed_windows': sum(bool(r.get('failed_windows')) for r in rows),
              'semantic_only': sum(r.get('window_verdict') == 'allow' and r['verdict'] == 'review' for r in rows),
              'input_tokens': sum(r.get('input_tokens', 0) for r in rows)}
    save(args.output / 'summary.json', result)
    fields = ['index', 'video_id', 'language', 'gold', 'verdict', 'window_verdict', 'predicted_harmful', 'correct',
              'failed_windows', 'peak', 'elapsed_sec', 'error', 'report_path']
    with (args.output / 'results.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--selection', type=Path, required=True, help='selection.json of an earlier frozen test (samples list)')
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--concurrency', type=int, choices=range(1, 17), default=4)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    from short_video_moderation.desktop import default_settings, resolve_policy, start_moderation, cancel_jobs
    from short_video_moderation.library import load_saved_settings, stored_key

    selection_path = args.output / 'selection.json'
    if selection_path.exists():
        selection = read(selection_path)['samples']
    else:
        selection = [{k: s[k] for k in ('index', 'video_id', 'language', 'gold', 'video_path', 'video_sha256')}
                     for s in read(args.selection)['samples']]
        save(selection_path, {'source': str(args.selection), 'created_at': now(), 'samples': selection})
    saved = load_saved_settings()
    settings = {**default_settings(), **saved, 'skip_reviewed': False, 'stop_on_block': False, 'video_concurrency': args.concurrency}
    policy = resolve_policy(settings)
    settings_info = {'provider': 'jev', 'modality': 'multimodal', 'interval': 0.5, 'segment_seconds': 8,
                     'jev_model': settings['jev_model'], 'asr_engine': settings['asr_engine'],
                     'full_text': settings.get('full_text') is not False, 'speech_context': settings.get('speech_context') is not False,
                     'review_threshold': policy['review_threshold'], 'block_threshold': policy['block_threshold'],
                     'categories': {k: {'label': r.get('label'), 'review': r.get('review_threshold'), 'block': r.get('block_threshold')}
                                    for k, r in policy['categories'].items()},
                     'mapping': 'allow -> Normal; review/block/failed -> Harmful', 'inputs': 'video only (frames + own ASR)'}
    protocol_path = args.output / 'protocol.json'
    if protocol_path.exists():
        if read(protocol_path)['settings'] != settings_info:
            raise ValueError('Settings changed since this test was frozen; use a new output folder')
    else:
        save(protocol_path, {'created_at': now(), 'settings': settings_info, 'policy': policy,
                             'labels_or_titles_sent': False, 'videos': len(selection)})
    print('FROZEN', json.dumps({'videos': len(selection), **{k: settings_info[k] for k in ('jev_model', 'asr_engine', 'full_text',
          'review_threshold', 'block_threshold')}, 'categories': list(settings_info['categories'])}, ensure_ascii=False), flush=True)
    if args.prepare_only:
        return 0
    if not (stored_key('jev') or os.environ.get('TYPESAFE_API_KEY')):
        raise SystemExit('No JEV key: save it in the app with "remember keys" on, or set TYPESAFE_API_KEY')
    if os.environ.get('MIMO_API_KEY'):
        settings['asr_api_key'] = os.environ['MIMO_API_KEY']  # used for this run only, never written to disk

    jobs_root = args.runtime / 'jobs'
    jobs_root.mkdir(parents=True, exist_ok=True)
    lock, fatal = threading.Lock(), threading.Event()

    def run_one(record):
        started = time.monotonic()
        finished = {}
        def receive(event, **fields):
            if event in ('moderation.completed', 'moderation.failed', 'moderation.cancelled', 'moderation.rejected'):
                finished.update(type=event, **fields)
        result = {k: record[k] for k in ('index', 'video_id', 'language', 'gold')}
        try:
            if sha(record['video_path']) != record['video_sha256']:
                raise ValueError('Video changed since the selection was frozen')
            payload = {'job_id': record['video_id'], 'video_path': record['video_path'], 'output_root': str(jobs_root),
                       'provider': 'jev', 'modality': 'multimodal', 'settings': settings, 'upload_consent': True,
                       'interval': 0.5, 'segment_seconds': 8}
            thread = start_moderation(payload, receive)
            if thread is None:
                raise RuntimeError('Task rejected')
            thread.join()
            if finished.get('type') != 'moderation.completed':
                raise RuntimeError(finished.get('error', 'No completion event'))
            report = finished['report']
            jev = report['providers']['jev']
            window_verdict, verdict = video_verdict(jev)
            dest = args.output / 'reports' / record['video_id']
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy2(report['report_path'], dest / 'report.json')
            errors = [r.get('error_type') for r in jev['segments'] if r['status'] == 'failed']
            if jev.get('transcript') and jev['transcript']['status'] == 'failed':
                errors.append('full_text:' + str(jev['transcript'].get('error_type')))
            result.update(verdict=verdict, window_verdict=window_verdict, failed_windows=errors,
                          peak=max((max(r['probabilities'].values()) for r in jev['segments'] if r['status'] == 'completed'), default=None),
                          input_tokens=jev.get('usage', {}).get('input_tokens', 0), report_path=str(dest / 'report.json'))
            if any(str(e) in ('http_401', 'http_402', 'http_403') for e in errors):
                fatal.set()
        except Exception as error:
            result.update(verdict='failed', error=str(error)[:300])
            if any(code in str(error) for code in ('401', '402', '403')):
                fatal.set()
        result['predicted_harmful'] = result['verdict'] != 'allow'
        result['correct'] = result['predicted_harmful'] == (record['gold'] != 'Normal')
        result['elapsed_sec'] = round(time.monotonic() - started, 1)
        save(args.output / 'results' / f"{record['video_id']}.json", result)
        return result

    done = {p.stem for p in (args.output / 'results').glob('*.json')}
    pending = [r for r in selection if r['video_id'] not in done]
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        queue, running = iter(pending), {}
        def submit():
            record = None if fatal.is_set() or (args.output / 'STOP').exists() else next(queue, None)
            if record:
                running[pool.submit(run_one, record)] = record
        submit()  # the first video is a preflight; the rest start once it finishes
        widened = bool(done)
        if widened:
            for _ in range(args.concurrency - 1):
                submit()
        while running:
            finished_now, _ = wait(running, timeout=15, return_when=FIRST_COMPLETED)
            for future in finished_now:
                record = running.pop(future)
                r = future.result()
                done.add(record['video_id'])
                print(f"DONE {len(done)}/{len(selection)} {record['video_id']} {r['verdict']} gold={record['gold']} "
                      f"{'OK' if r['correct'] else 'WRONG'} {r['elapsed_sec']}s {r.get('error', '')}", flush=True)
                submit()
            if finished_now and not widened:
                for _ in range(args.concurrency - 1):
                    submit()
                widened = True
            if finished_now:
                summarize(args, selection, settings_info)
            if fatal.is_set():
                cancel_jobs()
    summary = summarize(args, selection, settings_info)
    print('FINAL', json.dumps({k: summary[k] for k in ('processed', 'overall', 'verdicts', 'job_failures')}, ensure_ascii=False), flush=True)
    return 0 if summary['processed'] == len(selection) else 2


if __name__ == '__main__':
    raise SystemExit(main())
