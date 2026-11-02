import { VERDICT_ZH, categoriesOf, categoryLabel, errorText, fmtTime, isFailed, isSkipped, pad2, providerLabel, providersOf, tally, thresholds, type SegmentView } from "../lib/report";
import { VerdictTag, VideoTag } from "./Results";
import type { VideoItem } from "../types";

const MODALITY: Record<string, string> = { multimodal: "画面＋转写", visual: "仅画面", text: "仅转写" };

function Caveats({ cloudAsr }: { cloudAsr: boolean }) {
  return <ul className="caveats">
    <li>阈值未校准</li>
    <li>JEV 概率 ≠ 对照自报分数</li>
    <li>片段范围 ≠ 违规时刻</li>
    {cloudAsr && <li className="warn">云端 ASR 时间为语音段级</li>}
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
          {row.evidence === "asr_failed" && <p className="notice v-failed">语音识别失败，仅按画面判断</p>}
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
          <div><dt>归类</dt><dd>{video.verdict ? VERDICT_ZH[video.verdict] : "—"}</dd></div>
          {Object.entries(counts).map(([p, c]) => <div key={p}><dt>{providerLabel(p)}</dt>
            <dd>通过 {c.allow} · <span className="t-block">拦截 {c.block}</span> · <span className="t-review">待定 {c.review}</span>{c.failed ? <span className="t-failed"> · 失败 {c.failed}</span> : null}</dd></div>)}
          <div><dt>模态</dt><dd>{report?.modality ? MODALITY[report.modality] ?? report.modality : "—"}</dd></div>
          <div><dt>阈值</dt><dd>复核 ≥ {limits.review.toFixed(2)} · 拦截 ≥ {limits.block.toFixed(2)}</dd></div>
          <div><dt>报告</dt><dd title={report?.report_path}>{report?.report_path ?? "—"}</dd></div>
        </dl>
        {video.error && <p className="notice v-failed">{video.error}</p>}
      </div>
    </section>;
  }

  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>SUMMARY</b> · 运行说明</span></header>
    <div className="detail">
      <dl className="facts">
        <div><dt>阈值</dt><dd>复核 ≥ {limits.review.toFixed(2)} · 拦截 ≥ {limits.block.toFixed(2)}</dd></div>
        <div><dt>归类</dt><dd>整段取最严</dd></div>
      </dl>
      <Caveats cloudAsr={cloudAsr} />
    </div>
  </section>;
}
