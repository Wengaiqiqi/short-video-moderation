import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { categoryLabel, fmtTime, isFailed, pad2, peakOf, providerLabel, thresholds, verdictOf, type SegmentView } from "../lib/report";
import type { ModerationReport, ModerationRow } from "../types";

export function VerdictTag({ row }: { row?: ModerationRow }) {
  if (!row) return <span className="vtag none">—</span>;
  if (isFailed(row)) return <span className="vtag v-failed" title={row.error_type}>失败·待定</span>;
  const verdict = verdictOf(row);
  return <span className={`vtag v-${verdict}`}>{verdict === "allow" ? "通过" : verdict === "block" ? "拦截" : "待定"}</span>;
}

function topCategory(row?: ModerationRow) {
  const entries = Object.entries(row?.probabilities ?? {});
  if (!entries.length) return "—";
  return categoryLabel(entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]);
}

/** Per-window verdict table; rows select the window in the flow map. */
export default function Results({ report, providers, segments, selected, onSelect, preview }: {
  report: ModerationReport | null; providers: string[]; segments: SegmentView[];
  selected: number | null; onSelect: (id: number | null) => void; preview: boolean;
}) {
  const [error, setError] = useState("");
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    body.current?.querySelector("tr.on")?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const limits = thresholds(report);
  const failures = segments.filter(s => s.failed).length;
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>SEGMENTS</b> · 片段判定</span>
      {report && <button type="button" className="link-button" disabled={preview} title={preview ? "DEMO 预览没有报告文件" : report.report_path}
        onClick={() => { setError(""); void openPath(report.report_path).catch(e => setError(String(e))); }}>打开 JSON 报告 ↗</button>}
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!report ? <p className="empty">暂无结果。审核完成后，每个窗口的判定会列在这里。</p> : <>
      {failures > 0 && <p className="notice v-failed">{failures} 个片段推理失败，已归入「待定」，需人工复核。</p>}
      <div className="table-scroll">
        <table>
          <thead><tr><th>#</th><th>时间</th>{providers.map(p => <th key={p}>{providerLabel(p)}</th>)}<th>峰值</th><th>主类</th></tr></thead>
          <tbody ref={body}>{segments.map(segment => {
            const main = segment.rows[providers[0]];
            const peak = Math.max(...providers.map(p => peakOf(segment.rows[p])));
            return <tr key={segment.id} className={selected === segment.id ? "on" : undefined} tabIndex={0} aria-selected={selected === segment.id}
              onClick={() => onSelect(selected === segment.id ? null : segment.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(selected === segment.id ? null : segment.id); } }}>
              <td className="num">{pad2(segment.id)}</td>
              <td className="num">{fmtTime(segment.start)}–{fmtTime(segment.end)}</td>
              {providers.map(p => <td key={p}><VerdictTag row={segment.rows[p]} /></td>)}
              <td className={`num ${peak >= limits.block ? "t-block" : peak >= limits.review ? "t-review" : ""}`}>{peak.toFixed(3)}</td>
              <td>{topCategory(main && !isFailed(main) ? main : segment.rows[providers[1]])}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
