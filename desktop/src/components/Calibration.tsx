import { useEffect, useMemo, useState } from "react";
import { baseName, calibrate, providerLabel, providersOf, videoScore } from "../lib/report";
import type { ModerationPolicy, VideoItem } from "../types";

interface Props {
  videos: VideoItem[]; policy: ModerationPolicy | undefined;
  onApply: (patch: { review_threshold?: number; block_threshold?: number }) => void;
  onImport: () => Promise<{ name: string; blocked: boolean }[] | null>;
  onClose: () => void;
}

/**
 * Labels come from human final decisions (通过/拦截) and, optionally, an imported CSV matched by file name.
 * Each video's score is its highest category probability; "score ≥ threshold → 拦截" is compared with the labels.
 */
export default function Calibration({ videos, policy, onApply, onImport, onClose }: Props) {
  const [imported, setImported] = useState<{ name: string; blocked: boolean }[]>([]);
  const [provider, setProvider] = useState<string>("all");
  const [error, setError] = useState("");
  const reviewed = videos.filter(v => v.report);
  const available = Array.from(new Set(reviewed.flatMap(v => providersOf(v.report))));
  const samples = useMemo(() => {
    const byName = new Map(imported.map(l => [l.name, l.blocked]));
    return reviewed.flatMap(v => {
      const fromReview = v.review && v.review.decision !== "review" ? v.review.decision === "block" : undefined;
      const blocked = fromReview ?? byName.get(baseName(v.part?.source ?? v.path));
      if (blocked === undefined) return [];
      return [{ score: videoScore(v.report, provider === "all" ? undefined : [provider]), blocked }];
    });
  }, [reviewed, imported, provider]);
  const rows = useMemo(() => calibrate(samples), [samples]);
  const positives = samples.filter(s => s.blocked).length;
  const best = rows.reduce<typeof rows[number] | null>((a, r) => (!a || r.f1 > a.f1 ? r : a), null);
  // Review threshold: the highest one that still catches ≥ 95% of the videos that should be blocked.
  const reviewPick = [...rows].reverse().find(r => r.recall >= 0.95) ?? null;
  const current = policy?.block_threshold;
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal calibration" role="dialog" aria-modal="true" aria-label="阈值校准" onClick={e => e.stopPropagation()}>
      <header className="modal-head"><b>CALIBRATION</b><span className="meta">阈值校准</span>
        <span className="head-tools"><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button></span></header>
      <div className="calib-top">
        <span>标注 {samples.length} 个（应拦截 {positives}）</span>
        <span className="chips">
          {["all", ...available].map(p => <button key={p} type="button" className={provider === p ? "on" : undefined}
            onClick={() => setProvider(p)}>{p === "all" ? "全部模型" : providerLabel(p)}</button>)}
        </span>
        <button type="button" className="tool" onClick={() => { setError(""); void onImport().then(l => { if (l) setImported(l); }).catch(e => setError(String(e))); }}>
          导入标注 CSV{imported.length ? ` · ${imported.length}` : ""}</button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {samples.length < 2 || positives === 0 || positives === samples.length ?
        <p className="empty">需要同时有「应拦截」和「应通过」的标注。可在视频上做人工终判，或导入「文件名, 拦截/通过」格式的 CSV。</p> : <>
          <div className="calib-picks">
            {best && <button type="button" className="tool primary-tool" onClick={() => onApply({ block_threshold: best.threshold })}>
              拦截阈值设为 {best.threshold.toFixed(2)}（F1 最高 {best.f1.toFixed(2)}）</button>}
            {reviewPick && <button type="button" className="tool" onClick={() => onApply({ review_threshold: Math.min(reviewPick.threshold, (current ?? 1) - 0.05) })}>
              复核阈值设为 {Math.min(reviewPick.threshold, (current ?? 1) - 0.05).toFixed(2)}（召回 ≥ 95%）</button>}
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>阈值</th><th>准确率</th><th>精确率</th><th>召回率</th><th>F1</th><th>误拦</th><th>漏拦</th></tr></thead>
              <tbody>{rows.map(r => <tr key={r.threshold} className={`${r === best ? "on" : ""}${current != null && Math.abs(r.threshold - current) < 0.001 ? " current" : ""}`}
                onClick={() => onApply({ block_threshold: r.threshold })} title="点击设为拦截阈值">
                <td className="num">{r.threshold.toFixed(2)}{current != null && Math.abs(r.threshold - current) < 0.001 ? " ·当前" : ""}</td>
                <td className="num">{(r.accuracy * 100).toFixed(0)}%</td><td className="num">{(r.precision * 100).toFixed(0)}%</td>
                <td className="num">{(r.recall * 100).toFixed(0)}%</td><td className="num">{r.f1.toFixed(2)}</td>
                <td className={`num${r.fp ? " t-review" : ""}`}>{r.fp}</td><td className={`num${r.fn ? " t-block" : ""}`}>{r.fn}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </>}
    </div>
  </div>;
}
