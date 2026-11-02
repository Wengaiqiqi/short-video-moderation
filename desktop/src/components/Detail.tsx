import { VERDICT_ZH, categoriesOf, categoryLabel, errorText, fmtTime, isFailed, isSkipped, pad2, providerLabel, providersOf, tally, thresholds, type SegmentView } from "../lib/report";
import { VerdictTag, VideoTag } from "./Results";
import type { VideoItem } from "../types";

const MODALITY: Record<string, string> = { multimodal: "画面＋转写", visual: "仅画面", text: "仅转写" };

function Caveats({ cloudAsr }: { cloudAsr: boolean }) {
  return <ul className="caveats">
    <li>阈值为实验配置，尚未用验证集校准。</li>
    <li>JEV 概率与对照模型自报分数含义不同，不宜直接比较数值。</li>
    <li>片段时间范围不等于精确的违规发生时间；抽样可能漏掉短暂事件。</li>
    {cloudAsr && <li className="warn">云端 ASR 没有逐句时间戳：按静音切分成语音段识别，时间精度为语音段级。</li>}
  </ul>;
}

/** Selected window's scores; otherwise the selected video's summary; otherwise the caveats. */
export default function Detail({ video, providers, segment, cloudAsr }: {
  video: VideoItem | null; providers: string[]; segment: SegmentView | null; cloudAsr: boolean;
}) {
  const report = video?.report ?? null;
  const limits = thresholds(report);
  const categories = categoriesOf(report);
  if (segment) return <section className="panel dock-panel">
    <header className="panel-head"><span><b>SEG {pad2(segment.id)}</b> · 片段详情</span>
      <span className="meta">{fmtTime(segment.start)}–{fmtTime(segment.end)} · {(segment.end - segment.start).toFixed(1)}s</span></header>
    <div className="detail">
      {providers.map(provider => {
        const row = segment.rows[provider];
        if (!row) return null;
        return <div key={provider} className="detail-provider">
          <div className="detail-head"><b>{providerLabel(provider)}</b><VerdictTag row={row} />
            <span className="meta">{row.model ?? ""}{row.elapsed_sec != null ? ` · ${row.elapsed_sec.toFixed(2)}s` : ""}</span></div>
          {row.evidence === "asr_failed" && <p className="notice v-failed">该段语音识别失败，仅按画面判断，已至少归入待定。</p>}
          {isSkipped(row) ? <p className="hint">此窗口没有{row.skip_reason === "no_speech" ? "讲话" : row.skip_reason === "no_visual_evidence" ? "抽样画面" : "可审内容"}，未送审。</p>
            : isFailed(row) ? <p className="notice v-failed">推理失败（{errorText(row.error_type)}），本段需人工复核。</p>
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
      })}
    </div>
  </section>;

  if (video) {
    const counts = tally(report, providersOf(report));
    return <section className="panel dock-panel">
      <header className="panel-head"><span><b>VIDEO</b> · 视频概要</span><VideoTag video={video} /></header>
      <div className="detail">
        {video.thumb && <img className="detail-cover" src={video.thumb} alt="" />}
        <dl className="facts">
          <div><dt>文件</dt><dd title={video.path}>{video.path}</dd></div>
          <div><dt>归类</dt><dd>{video.verdict ? `${VERDICT_ZH[video.verdict]}（取最严：任一片段、任一模型）` : "—"}</dd></div>
          {Object.entries(counts).map(([p, c]) => <div key={p}><dt>{providerLabel(p)}</dt>
            <dd>通过 {c.allow} · <span className="t-block">拦截 {c.block}</span> · <span className="t-review">待定 {c.review}</span>{c.failed ? <span className="t-failed"> · 失败 {c.failed}</span> : null}</dd></div>)}
          <div><dt>模态</dt><dd>{report?.modality ? MODALITY[report.modality] ?? report.modality : "—"}</dd></div>
          <div><dt>阈值</dt><dd>复核 ≥ {limits.review.toFixed(2)} · 拦截 ≥ {limits.block.toFixed(2)}</dd></div>
          <div><dt>报告</dt><dd title={report?.report_path}>{report?.report_path ?? "—"}</dd></div>
        </dl>
        {video.error && <p className="notice v-failed">{video.error}</p>}
        {report && <p className="hint">在左侧表格中点击片段查看各类分数。</p>}
      </div>
    </section>;
  }

  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>SUMMARY</b> · 运行说明</span></header>
    <div className="detail">
      <dl className="facts">
        <div><dt>阈值</dt><dd>复核 ≥ {limits.review.toFixed(2)} · 拦截 ≥ {limits.block.toFixed(2)}</dd></div>
        <div><dt>归类</dt><dd>整段视频取最严：任一片段被任一模型拦截 → 拦截；有待定或失败 → 待定</dd></div>
      </dl>
      <Caveats cloudAsr={cloudAsr} />
      <p className="hint">点击右侧判定格或其中的封面查看审核结果。</p>
    </div>
  </section>;
}
