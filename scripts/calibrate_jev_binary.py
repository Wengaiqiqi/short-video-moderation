"""Binary Harmful/Normal evaluation of JEV with a threshold chosen on labelled non-test data.

Uses an existing native run (no new API requests). Fixed before any result is computed:
- Label: Majority_Voting Hateful or Offensive -> Harmful, Normal -> Normal (the paper's binary setting).
- Video score: max over JEV-judged windows of max(category probabilities) under the run's policy.
- Threshold: maximises binary macro-F1 on the calibration videos; ties go to the median tied threshold.
  Primary calibration set = the official valid split; train+valid is reported as a stability check.
- Test: the official test split, scored once per threshold. Test labels never influence a threshold.
- Uncertainty: bootstrap 95% intervals on the test videos; repeated 5-fold CV over all videos as a larger-sample check.

  python scripts/calibrate_jev_binary.py --run <run dir> --output <dir>
"""
from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SEED, BOOTSTRAP, REPEATS, FOLDS = 20261103, 5000, 20, 5
# Binary results reported by the MultiHateClip paper (arXiv 2408.03468v2, Tables 8 and 9), full official test split.
# "Harmful" columns are the paper's merged Offensive class (F1(O), R(O), P(O)).
PAPER = {
    'English': {'GPT-4V (VL2)': (0.81, 0.79, 0.73, 0.72, 0.73), 'GPT-4 text (T2)': (0.81, 0.79, 0.73, 0.69, 0.78),
                'Fusion M1': (0.75, 0.74, 0.67, 0.61, 0.77), 'ViViT (V1)': (0.73, 0.73, 0.68, 0.57, 0.86)},
    'Chinese': {'Fusion M1': (0.80, 0.78, 0.71, 0.66, 0.78), 'ViViT (V1)': (0.77, 0.76, 0.71, 0.60, 0.85),
                'GPT-4V (VL2)': (0.72, 0.69, 0.59, 0.59, 0.60), 'GPT-4 text (T2)': (0.69, 0.68, 0.63, 0.51, 0.84)},
}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def load(run):
    videos, skipped = [], []
    for row in csv.DictReader((run / 'results.csv').open(encoding='utf-8-sig')):
        report_path = run / 'reports' / row['video_id'] / 'report.json'
        splits = json.loads(row['splits'])
        if not report_path.exists():
            skipped.append({'video_id': row['video_id'], 'split': splits, 'reason': 'native_job_failed'})
            continue
        report = read(report_path)
        judged = [r['probabilities'] for r in report['providers']['jev']['segments'] if r['status'] == 'completed']
        if not judged:
            skipped.append({'video_id': row['video_id'], 'split': splits, 'reason': 'no_window_judged'})
            continue
        videos.append({'video_id': row['video_id'], 'language': row['language'], 'gold': row['gold'],
                       'split': splits[0] if len(splits) == 1 else 'mixed', 'harmful': int(row['gold'] != 'Normal'),
                       'score': max(max(p.values()) for p in judged), 'complete': row['model_complete'] == 'True',
                       'categories': sorted(report['policy']['categories'])})
    return videos, skipped


def macro_f1(y, pred):
    f1 = []
    for label in (0, 1):
        tp, fp, fn = np.sum((pred == label) & (y == label)), np.sum((pred == label) & (y != label)), np.sum((pred != label) & (y == label))
        f1.append(2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.0)
    return float(np.mean(f1))


def threshold_for(scores, y):
    values = np.unique(scores)
    candidates = np.concatenate([[values[0] - 1e-6], (values[:-1] + values[1:]) / 2, [values[-1] + 1e-6]])
    results = np.array([macro_f1(y, (scores >= t).astype(int)) for t in candidates])
    tied = candidates[np.isclose(results, results.max())]
    return float(tied[len(tied) // 2]), float(results.max())


def metrics(y, pred):
    tp, fp, fn = int(np.sum((pred == 1) & (y == 1))), int(np.sum((pred == 1) & (y == 0))), int(np.sum((pred == 0) & (y == 1)))
    precision, recall = tp / (tp + fp) if tp + fp else 0.0, tp / (tp + fn) if tp + fn else 0.0
    return {'n': int(len(y)), 'harmful': int(y.sum()), 'accuracy': float(np.mean(pred == y)), 'macro_f1': macro_f1(y, pred),
            'harmful_f1': 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.0, 'harmful_recall': recall, 'harmful_precision': precision,
            'confusion': {'harmful_as_harmful': tp, 'harmful_as_normal': fn, 'normal_as_harmful': fp, 'normal_as_normal': int(np.sum((pred == 0) & (y == 0)))}}


def with_ci(y, pred, rng):
    out = metrics(y, pred)
    draws = rng.integers(0, len(y), size=(BOOTSTRAP, len(y)))
    for key, fn in (('accuracy', lambda a, b: float(np.mean(a == b))), ('macro_f1', macro_f1)):
        values = np.array([fn(y[d], pred[d]) for d in draws])
        out[key + '_ci95'] = [float(np.percentile(values, 2.5)), float(np.percentile(values, 97.5))]
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    videos, skipped = load(args.run)
    save(args.output / 'protocol.json', {
        'created_at': datetime.now(timezone.utc).isoformat(), 'run': str(args.run), 'api_requests': 0,
        'label': 'Hateful or Offensive -> Harmful; Normal -> Normal (Majority_Voting)',
        'score': 'max over JEV-judged windows of max category probability; categories: ' + ', '.join(videos[0]['categories']),
        'threshold_rule': 'maximise binary macro-F1 on calibration videos; ties -> median tied threshold; one threshold for both languages',
        'calibration_sets': {'primary': 'official valid split', 'stability': 'official train + valid'},
        'test_set': 'official test split', 'fixed_references': [0.5, 0.4],
        'bootstrap': BOOTSTRAP, 'cv_check': {'repeats': REPEATS, 'folds': FOLDS, 'strata': 'language x label', 'seed': SEED},
        'skipped': skipped, 'paper_reference': PAPER})

    y = np.array([v['harmful'] for v in videos])
    score = np.array([v['score'] for v in videos])
    split = np.array([v['split'] for v in videos])
    language = np.array([v['language'] for v in videos])
    test = split == 'test'
    calibrations = {'valid': split == 'valid', 'train+valid': np.isin(split, ['train', 'valid'])}
    rng = np.random.default_rng(SEED)

    settings = {'fixed 0.5': 0.5, 'fixed 0.4': 0.4}
    chosen = {}
    for name, mask in calibrations.items():
        t, fit = threshold_for(score[mask], y[mask])
        settings[f'calibrated on {name}'] = t
        chosen[name] = {'threshold': t, 'calibration_videos': int(mask.sum()), 'calibration_harmful': int(y[mask].sum()),
                        'calibration_macro_f1': fit}
    results = {}
    for name, t in settings.items():
        pred = (score >= t).astype(int)
        results[name] = {'threshold': t, 'all': with_ci(y[test], pred[test], rng),
                         **{lang: with_ci(y[test & (language == lang)], pred[test & (language == lang)], rng) for lang in ('Chinese', 'English')}}

    # Larger-sample check: thresholds picked on 4/5 of all videos, scored on the held-out 1/5.
    from sklearn.model_selection import StratifiedKFold
    strata = np.array([f'{l}-{h}' for l, h in zip(language, y)])
    cv = {scope: [] for scope in ('all', 'Chinese', 'English')}
    for repeat in range(REPEATS):
        pred = np.zeros(len(y), dtype=int)
        for cal, held in StratifiedKFold(FOLDS, shuffle=True, random_state=SEED + repeat).split(score, strata):
            pred[held] = score[held] >= threshold_for(score[cal], y[cal])[0]
        cv['all'].append(macro_f1(y, pred))
        for lang in ('Chinese', 'English'):
            mask = language == lang
            cv[lang].append(macro_f1(y[mask], pred[mask]))
    cv_summary = {k: {'mean': float(np.mean(v)), 'sd': float(np.std(v, ddof=1)), 'min': float(np.min(v)), 'max': float(np.max(v)),
                      'videos': int(len(y) if k == 'all' else np.sum(language == k))} for k, v in cv.items()}

    save(args.output / 'results.json', {'videos': len(videos), 'skipped': skipped, 'test_videos': int(test.sum()),
                                        'thresholds': chosen, 'test': results, 'cv_check': cv_summary, 'paper': PAPER})
    with (args.output / 'predictions.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['video_id', 'language', 'split', 'gold', 'harmful', 'jev_score', *settings])
        for i, v in enumerate(videos):
            writer.writerow([v['video_id'], v['language'], v['split'], v['gold'], v['harmful'], f"{v['score']:.3f}",
                             *(int(score[i] >= t) for t in settings.values())])
    print(json.dumps({'thresholds': chosen, 'test_macro_f1': {k: round(r['all']['macro_f1'], 3) for k, r in results.items()},
                      'cv': {k: round(v['mean'], 3) for k, v in cv_summary.items()}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
