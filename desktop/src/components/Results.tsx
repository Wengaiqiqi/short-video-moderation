import { useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { ModerationReport } from "../types";

export default function Results({ report }: { report: ModerationReport }) {
  const [error, setError] = useState("");
  const actions: Record<string, string> = { allow: "通过", review: "人工复核", block: "拦截" };
  return <section className="card"><div className="section-heading"><h2>审核结果</h2>
    <button onClick={() => { void openPath(report.report_path).catch(e => setError(String(e))); }}>打开 JSON 报告</button></div>
    {error && <p role="alert">{error}</p>}
    {Object.entries(report.providers).map(([provider, result]) => <section key={provider}>
      <h3>{provider === "jev" ? "Jev" : "多模态对照组"} · {result.complete ? "已完成" : "存在失败片段，需复核"}</h3>
      <div className="table-scroll"><table><thead><tr><th>片段</th><th>时间（秒）</th><th>结果</th><th>分类分数</th></tr></thead>
        <tbody>{result.segments.map(row => <tr key={row.segment_id}><td>{row.segment_id}</td><td>{row.start_sec.toFixed(2)}–{row.end_sec.toFixed(2)}</td>
          <td><span className={`badge ${row.action}`}>{row.status === "failed" ? "失败 · 人工复核" : actions[row.action] || row.action}</span></td>
          <td>{row.probabilities ? Object.entries(row.probabilities).map(([key, value]) => `${key}: ${value.toFixed(3)}`).join(" / ") : row.error_type || "—"}</td></tr>)}</tbody>
      </table></div></section>)}
    <p className="muted">阈值尚需验证集校准。Jev 概率与对照模型自报分数的含义不同，片段范围也不等于精确违规时间。</p>
  </section>;
}
