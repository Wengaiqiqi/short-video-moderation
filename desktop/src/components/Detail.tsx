import { VERDICT_ZH, addCosts, categoryLabel, costOf, errorText, flaggedSentences, fmtTime, fmtTokens, pad2, providerLabel,
         providersOf, tally, thresholds, transcriptsOf, verdictOf, type SegmentView } from "../lib/report";
import { EvidenceStrip, Scores, useClip, useEvidence, type Request } from "./Evidence";
import { VideoTag } from "./Results";
import type { ModerationReport, Settings, VideoItem } from "../types";

const MODALITY: Record<string, string> = { multimodal: "画面＋转写", visual: "仅画面", text: "仅转写" };

function CostLine({ cost }: { cost: ReturnType<typeof costOf> }) {
  const parts = Object.entries(cost.tokens).filter(([, n]) => n > 0).map(([p, n]) => `${providerLabel(p)} ${fmtTokens(n)}`);
  return <>{parts.length ? parts.join(" · ") : "—"}{cost.asrSeconds ? ` · 语音 ${(cost.asrSeconds / 60).toFixed(1)} 分钟` : ""}</>;
}

/** The whole transcript with the sentences named by the whole-transcript judgement highlighted. */
function Transcript({ report, providers, offset, only, onSegment }: {
  report: ModerationReport; providers: string[]; offset: number; only?: number; onSegment?: (id: number) => void;
}) {
  const flagged = flaggedSentences(report, providers);
  const lines = (report.transcript ?? []).filter(s => only == null || s.segments.includes(only));
  const shown = only == null ? lines : lines.filter(s => flagged.has(s.id));
  if (!shown.length) return null;
  return <ol className={`sentences${only == null ? " scroll" : ""}`}>
    {shown.map(s => {
      const categories = flagged.get(s.id);
      const go = onSegment && s.segments.length ? () => onSegment(s.segments[0]) : undefined;
      return <li key={s.id} className={categories ? "flagged" : undefined}>
        <button type="button" className="sentence" disabled={!go} onClick={go}
          title={go ? `查看片段 ${s.segments.map(pad2).join("、")}` : undefined}>
          <span className="num">{fmtTime(s.start_sec + offset)}</span>
          <span className="sentence-text">{s.text}</span>
          {categories && <span className="sentence-tags">{[...categories].map(c => categoryLabel(c, report)).join(" · ")}</span>}
        </button>
      </li>;
    })}
  </ol>;
}

/** Whether the whole-transcript judgement named a sentence inside this window. */
function named(report: ModerationReport, providers: string[], window: number) {
  const flagged = flaggedSentences(report, providers);
  return !!report.transcript?.some(s => s.segments.includes(window) && flagged.has(s.id));
}

/** One line per provider: the whole-transcript verdict. */
function FullTextFacts({ report, providers }: { report: ModerationReport; providers: string[] }) {
  const texts = transcriptsOf(report, providers);
  if (!texts.length) return null;
  return <div><dt>全文</dt><dd>{texts.map(([provider, text], i) => {
    const verdict = text.status === "skipped" ? "未送审" : text.status !== "completed" ? `失败（${errorText(text.error_type)}）`
      : VERDICT_ZH[verdictOf(text)];
    const tone = text.status === "completed" ? verdictOf(text) : text.status === "failed" ? "failed" : "allow";
    return <span key={provider}>{i ? " · " : ""}{providers.length > 1 ? `${providerLabel(provider)} ` : ""}
      <span className={tone === "allow" ? undefined : `t-${tone}`}>{verdict}</span></span>;
  })}</dd></div>;
}

/** Selected window's evidence and scores; otherwise the selected video's summary; otherwise the batch summary. */
export default function Detail({ video, videos, providers, segment, cloudAsr, settings, request, onOpenEvidence, onCalibrate, onSegment }: {
  video: VideoItem | null; videos: VideoItem[]; providers: string[]; segment: SegmentView | null; cloudAsr: boolean;
  settings: Settings | null; request: Request; onOpenEvidence: () => void; onCalibrate: () => void; onSegment: (id: number) => void;
}) {
  const evidence = useEvidence(video, segment, request);
  const { clip, load } = useClip(video, segment, request);
  const report = video?.report ?? null;
  const limits = thresholds(report);

  if (segment && video) return <section className="panel dock-panel">
    <header className="panel-head"><span><b>片段 {pad2(segment.id)}</b></span>
      <span className="meta">{fmtTime(segment.start + (video.part?.start_sec ?? 0))}–{fmtTime(segment.end + (video.part?.start_sec ?? 0))} · {(segment.end - segment.start).toFixed(1)}s</span></header>
    <div className="detail">
      <EvidenceStrip evidence={evidence} clip={clip} onOpen={onOpenEvidence} onPlay={() => void load()} />
      {report && named(report, providers, segment.id) && <div className="detail-provider">
        <div className="detail-head"><b>全文判断定位</b><span className="meta">结合上下文</span></div>
        <Transcript report={report} providers={providers} offset={video.part?.start_sec ?? 0} only={segment.id} />
      </div>}
      <Scores video={video} segment={segment} providers={providers} />
    </div>
  </section>;

  if (video) {
    const counts = tally(report, providersOf(report));
    return <section className="panel dock-panel">
      <header className="panel-head"><span><b>视频</b></span><VideoTag video={video} /></header>
      <div className="detail">
        {video.thumb && <img className="detail-cover" src={video.thumb} alt="" />}
        <dl className="facts">
          <div><dt>文件</dt><dd title={video.path}>{video.path}</dd></div>
          {video.part && <div><dt>分段</dt><dd>第 {video.part.index}/{video.part.total} 段 · {fmtTime(video.part.start_sec, false)}–{fmtTime(video.part.end_sec, false)}</dd></div>}
          <div><dt>模型</dt><dd>{video.verdict ? VERDICT_ZH[video.verdict] : "—"}</dd></div>
          <div><dt>人工</dt><dd>{video.review ? `${VERDICT_ZH[video.review.decision]}${video.review.note ? ` · ${video.review.note}` : ""}` : "—"}</dd></div>
          {Object.entries(counts).map(([p, c]) => <div key={p}><dt>{providerLabel(p)}</dt>
            <dd>通过 {c.allow} · <span className="t-block">拦截 {c.block}</span> · <span className="t-review">待定 {c.review}</span>{c.failed ? <span className="t-failed"> · 失败 {c.failed}</span> : null}</dd></div>)}
          {report && <FullTextFacts report={report} providers={providers} />}
          <div><dt>模态</dt><dd>{report?.modality ? MODALITY[report.modality] ?? report.modality : "—"}{report?.speech_context ? " · 含前后句" : ""}</dd></div>
          <div><dt>用量</dt><dd><CostLine cost={costOf(report)} /></dd></div>
          {report?.frame_statistics && <div><dt>抽帧</dt><dd>{report.frame_statistics.kept}/{report.frame_statistics.sampled}（去重后）</dd></div>}
        </dl>
        {video.error && <p className="notice v-failed">{video.error}</p>}
        {report?.transcript?.length ? <>
          <h4 className="detail-sub">全文转写<span className="meta">{report.transcript.length} 句</span></h4>
          <Transcript report={report} providers={providers} offset={video.part?.start_sec ?? 0} onSegment={onSegment} />
        </> : null}
      </div>
    </section>;
  }

  const batch = videos.filter(v => v.status === "done" && !v.history);
  const total = addCosts(batch.map(v => costOf(v.report)));
  const labelled = videos.filter(v => v.review && v.review.decision !== "review" && v.report).length;
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>运行说明</b></span>
      <button type="button" className="link-button" onClick={onCalibrate} title="用人工终判或标注文件校准阈值">阈值校准{labelled ? ` · ${labelled}` : ""}</button></header>
    <div className="detail">
      <dl className="facts">
        <div><dt>阈值</dt><dd>复核 ≥ {limits.review.toFixed(2)} · 拦截 ≥ {limits.block.toFixed(2)}</dd></div>
        <div><dt>归类</dt><dd>整段取最严 · 仅全文报出归待定</dd></div>
        <div><dt>本批用量</dt><dd><CostLine cost={total} /></dd></div>
      </dl>
      <ul className="caveats">
        <li className={settings?.policy?.calibrated_at ? "ok" : undefined}>{settings?.policy?.calibrated_at ? `阈值已于 ${settings.policy.calibrated_at} 校准` : "阈值未校准"}</li>
        <li>JEV 概率 ≠ 对照自报分数</li>
        <li>片段范围 ≠ 违规时刻</li>
        {cloudAsr && <li className="warn">云端 ASR 时间为语音段级</li>}
      </ul>
    </div>
  </section>;
}
