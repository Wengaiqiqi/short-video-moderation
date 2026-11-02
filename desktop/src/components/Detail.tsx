import { categoriesOf, categoryLabel, fmtTime, isFailed, pad2, providerLabel, thresholds, type SegmentView } from "../lib/report";
import { VerdictTag } from "./Results";
import type { ModerationReport } from "../types";

const MODALITY: Record<string, string> = { multimodal: "画面＋转写", visual: "仅画面", text: "仅转写" };

/** Scores of the selected window, or the run's caveats when nothing is selected. */
export default function Detail({ report, providers, segment, cloudAsr }: {
  report: ModerationReport | null; providers: string[]; segment: SegmentView | null; cloudAsr: boolean;
}) {
  const limits = thresholds(report);
  const categories = categoriesOf(report);
  return <section className="panel dock-panel">
    <header className="panel-head">
      <span><b>{segment ? `SEG ${pad2(segment.id)}` : "SUMMARY"}</b> · {segment ? "片段详情" : "运行说明"}</span>
      {segment && <span className="meta">{fmtTime(segment.start)}–{fmtTime(segment.end)} · {(segment.end - segment.start).toFixed(1)}s</span>}
    </header>
    <div className="detail">
      {segment ? providers.map(provider => {
        const row = segment.rows[provider];
        if (!row) return null;
        return <div key={provider} className="detail-provider">
          <div className="detail-head"><b>{providerLabel(provider)}</b><VerdictTag row={row} />
            <span className="meta">{row.model ?? ""}{row.elapsed_sec != null ? ` · ${row.elapsed_sec.toFixed(2)}s` : ""}</span></div>
          {isFailed(row) ? <p className="notice v-failed">推理失败（{row.error_type ?? "未知错误"}），本段需人工复核。</p>
            : categories.map(category => {
              const value = row.probabilities?.[category] ?? 0;
              const tone = value >= limits.block ? "block" : value >= limits.review ? "review" : "allow";
              return <div key={category} className="score">
                <span className="score-name">{categoryLabel(category)}</span>
                <span className="score-bar"><i className={`v-${tone}`} style={{ width: `${value * 100}%` }} />
                  <em style={{ left: `${limits.review * 100}%` }} /><em className="hi" style={{ left: `${limits.block * 100}%` }} /></span>
                <span className={`score-value t-${tone}`}>{value.toFixed(3)}</span>
              </div>;
            })}
          {row.visual_evidence === "no_sample_in_interval" && <p className="hint">此窗口内没有抽样画面。</p>}
        </div>;
      }) : <>
        <dl className="facts">
          <div><dt>策略</dt><dd>{report?.policy?.version ?? "—"}</dd></div>
          <div><dt>阈值</dt><dd>复核 ≥ {limits.review.toFixed(2)} · 拦截 ≥ {limits.block.toFixed(2)}</dd></div>
          <div><dt>模态</dt><dd>{report?.modality ? MODALITY[report.modality] ?? report.modality : "—"}</dd></div>
          <div><dt>输入指纹</dt><dd title={report?.input_hash}>{report?.input_hash ? report.input_hash.slice(0, 16) : "—"}</dd></div>
        </dl>
        <ul className="caveats">
          <li>阈值为实验配置，尚未用验证集校准。</li>
          <li>JEV 概率与对照模型自报分数含义不同，不宜直接比较数值。</li>
          <li>片段时间范围不等于精确的违规发生时间；抽样可能漏掉短暂事件。</li>
          {cloudAsr && <li className="warn">云端 ASR 按 30 秒音频块对齐，窗口边界精度较低。</li>}
        </ul>
        {report && <p className="hint">点击左侧砖块、流向线或表格行查看单个片段。</p>}
      </>}
    </div>
  </section>;
}
