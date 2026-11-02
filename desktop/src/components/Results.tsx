import { useEffect, useRef, useState } from "react";
import {
  VERDICTS, VERDICT_ZH, agreement, categoryLabel, disagreements, errorText, finalVerdict, fmtDuration, fmtTime, isFailed, isSkipped,
  pad2, peakOf, providerLabel, providersOf, segmentsOf, semanticOnly, semanticWindows, tally, thresholds, transcriptFailures,
  transcriptsOf, verdictOf, visibleProviders, type ProviderFilter, type SegmentView, type Verdict,
} from "../lib/report";
import type { ModerationReport, ModerationRequest, ModerationRow, ReviewDecision, TranscriptJudgement, VideoItem } from "../types";

export function VerdictTag({ row }: { row?: ModerationRow }) {
  if (!row) return <span className="vtag none">—</span>;
  if (isSkipped(row)) return <span className="vtag none" title="此窗口没有该模态的证据，未送审">跳过</span>;
  if (isFailed(row)) return <span className="vtag v-failed" title={errorText(row.error_type)}>失败·待定</span>;
  const verdict = verdictOf(row);
  return <span className={`vtag v-${verdict}`} title={row.evidence === "asr_failed" ? "语音识别失败，仅按画面判断" : undefined}>
    {VERDICT_ZH[verdict]}{row.evidence === "asr_failed" ? "*" : ""}</span>;
}
export function VideoTag({ video }: { video: VideoItem }) {
  if (video.status === "queued") return <span className="vtag none">排队</span>;
  if (video.status === "running") return <span className="vtag v-running">审核中</span>;
  if (video.status === "cancelled") return <span className="vtag none">已取消</span>;
  if (video.status === "failed") return <span className="vtag v-failed" title={video.error}>处理失败·待定</span>;
  const verdict = finalVerdict(video) ?? "review";
  const semantic = !video.review && semanticOnly(video.report);
  return <span className={`vtag v-${verdict}`}
    title={video.review ? `人工终判（模型：${VERDICT_ZH[video.verdict ?? "review"]}）` : semantic ? "窗口均通过，全文判断发现问题" : undefined}>
    {VERDICT_ZH[verdict]}{video.review ? " · 人工" : semantic ? " · 全文" : ""}</span>;
}

/** Tag for one whole-transcript judgement. */
function TextTag({ text }: { text: TranscriptJudgement }) {
  if (text.status === "skipped") return <span className="vtag none">{text.skip_reason === "no_speech" ? "无讲话" : "未送审"}</span>;
  if (text.status !== "completed") return <span className="vtag v-failed" title={errorText(text.error_type)}>失败·待定</span>;
  const verdict = verdictOf(text);
  return <span className={`vtag v-${verdict}`}>{VERDICT_ZH[verdict]}</span>;
}

/** One line: the whole-transcript verdict of each visible provider and the windows it points to. */
function FullText({ report, providers, segment, onSegment }: {
  report: ModerationReport; providers: string[]; segment: number | null; onSegment: (id: number | null) => void;
}) {
  const texts = transcriptsOf(report, providers);
  if (!texts.length) return null;
  const windows = [...new Set(texts.flatMap(([, t]) => t.windows ?? []))].sort((a, b) => a - b);
  return <div className="fulltext">
    <span className="fulltext-name">全文判断</span>
    {texts.map(([provider, text]) => {
      const top = Object.entries(text.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
      const detail = [top ? `${categoryLabel(top[0], report)} ${top[1].toFixed(3)}` : "", text.status === "failed" ? errorText(text.error_type) : "",
                      text.elapsed_sec != null ? `${text.elapsed_sec.toFixed(1)}s` : ""].filter(Boolean).join(" · ");
      return <span key={provider} className="fulltext-item" title={detail || undefined}>
        {providers.length > 1 && <span className="meta">{providerLabel(provider)}</span>}<TextTag text={text} /></span>;
    })}
    {windows.length > 0 && <span className="fulltext-windows" role="group" aria-label="全文判断定位的片段">
      {windows.map(id => <button key={id} type="button" className={segment === id ? "on" : undefined}
        onClick={() => onSegment(segment === id ? null : id)} title="查看此片段">{pad2(id)}</button>)}
    </span>}
  </div>;
}

function topCategory(row: ModerationRow | undefined, report: ModerationReport | null) {
  const entries = Object.entries(row?.probabilities ?? {});
  if (!entries.length) return "—";
  return categoryLabel(entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0], report);
}

export type Rerun = Pick<ModerationRequest, "provider" | "modality">;
interface Props {
  videos: VideoItem[]; video: VideoItem | null; onVideo: (id: string | null) => void;
  bin: Verdict | null; onBin: (bin: Verdict | null) => void;
  segment: number | null; onSegment: (id: number | null) => void;
  filter: ProviderFilter; onFilter: (filter: ProviderFilter) => void;
  preview: boolean;
  scope: "batch" | "history"; onScope: (scope: "batch" | "history") => void;
  onExport: (videos: VideoItem[]) => void; onRefreshHistory: () => void;
  onReview: (id: string, decision: ReviewDecision["decision"] | null) => void;
  onRetryFailed: (id: string) => void; onRerun: (id: string, how: Rerun) => void;
  onCancel: (id: string) => void; onRequeue: (id: string) => void;
  /** Show the report in the file manager; resolves to an error message, if any. */
  onReveal: (reportPath: string) => Promise<string | undefined>;
}

/** Finished videos (filtered by bin); opening one shows its per-window verdicts. */
export default function Results(props: Props) {
  return props.video ? <VideoSegments {...props} video={props.video} /> : <VideoList {...props} />;
}

export function listedVideos(videos: VideoItem[], scope: Props["scope"], bin: Verdict | null) {
  const finished = videos.filter(v => (v.status === "done" || v.status === "failed") && (scope === "history" ? v.history : !v.history));
  return { finished, rows: bin ? finished.filter(v => finalVerdict(v) === bin) : finished };
}

function VideoList({ videos, onVideo, bin, onBin, scope, onScope, onExport, onRefreshHistory }: Props) {
  const { finished, rows } = listedVideos(videos, scope, bin);
  const historyCount = videos.filter(v => v.history).length;
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>视频结果</b></span>
      <span className="head-tools">
        <span className="chips" role="group" aria-label="范围">
          <button type="button" className={scope === "batch" ? "on" : undefined} aria-pressed={scope === "batch"} onClick={() => onScope("batch")}>本批</button>
          <button type="button" className={scope === "history" ? "on" : undefined} aria-pressed={scope === "history"} onClick={() => onScope("history")}>历史 {historyCount}</button>
        </span>
        {scope === "history" && <button type="button" className="link-button" onClick={onRefreshHistory} title="重新读取结果目录">刷新</button>}
        <button type="button" className="link-button" disabled={!rows.length} onClick={() => onExport(rows)} title="导出当前列表为 CSV">导出</button>
      </span>
    </header>
    <div className="toolbar">
      <span className="chips" role="group" aria-label="按判定筛选">
        <button type="button" className={!bin ? "on" : undefined} aria-pressed={!bin} onClick={() => onBin(null)}>全部 {finished.length}</button>
        {VERDICTS.map(v => <button key={v.id} type="button" className={`c-${v.id}${bin === v.id ? " on" : ""}`} aria-pressed={bin === v.id}
          onClick={() => onBin(bin === v.id ? null : v.id)}>{v.zh} {finished.filter(x => finalVerdict(x) === v.id).length}</button>)}
      </span>
    </div>
    {rows.length === 0 ? <p className="empty">{finished.length ? "此类暂无视频" : scope === "history" ? "结果目录中没有历史结果" : "暂无结果"}</p> :
      <div className="table-scroll">
        <table>
          <thead><tr><th>视频</th><th>结论</th><th>片段</th><th>拦截段</th><th>待定段</th><th>分歧</th><th>{scope === "history" ? "日期" : "用时"}</th></tr></thead>
          <tbody>{[...rows].reverse().map(v => {
            const counts = tally(v.report, providersOf(v.report));
            const sum = (k: "block" | "review") => Object.values(counts).reduce((a, c) => a + c[k], 0);
            const segments = Math.max(0, ...Object.values(v.report?.providers ?? {}).map(p => p.segments.length));
            const split = disagreements(v.report).size;
            return <tr key={v.id} tabIndex={0} onClick={() => onVideo(v.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onVideo(v.id); } }}>
              <td className="video-cell"><span className="q-thumb">{v.thumb ? <img src={v.thumb} alt="" /> : null}</span>
                <span className="v-name" title={v.path}>{v.name}</span>{v.cached && <span className="mini-tag" title="复用此前相同配置的结果">复用</span>}</td>
              <td><VideoTag video={v} /></td>
              <td className="num">{v.report ? segments : "—"}</td>
              <td className={`num${sum("block") ? " t-block" : ""}`}>{v.report ? sum("block") : "—"}</td>
              <td className={`num${sum("review") ? " t-review" : ""}`}>{v.report ? sum("review") : "—"}</td>
              <td className={`num${split ? " t-review" : ""}`}>{v.report && providersOf(v.report).length > 1 ? split : "—"}</td>
              <td className="num">{scope === "history" ? (v.finishedAt ? new Date(v.finishedAt).toLocaleDateString("zh-CN") : "—")
                : v.startedAt && v.finishedAt ? fmtDuration(v.finishedAt - v.startedAt) : "—"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </section>;
}

function VideoSegments({ video, onVideo, segment, onSegment, filter, onFilter, preview, onReview, onRetryFailed, onRerun, onCancel, onRequeue, onReveal }: Props & { video: VideoItem }) {
  const [error, setError] = useState("");
  const [only, setOnly] = useState<"split" | "semantic" | null>(null);
  const [rerun, setRerun] = useState<Rerun | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => { body.current?.querySelector("tr.on")?.scrollIntoView({ block: "nearest" }); }, [segment]);
  useEffect(() => { setOnly(null); setRerun(null); }, [video.id]);
  const report = video.report ?? null;
  const all = providersOf(report);
  const providers = visibleProviders(report, filter);
  const split = disagreements(report);
  const semantic = semanticWindows(report, providers);
  const segments: SegmentView[] = segmentsOf(report, providers)
    .filter(s => only === "split" ? split.has(s.id) : only === "semantic" ? semantic.has(s.id) : true);
  const failedWindows = segmentsOf(report, all).filter(s => s.failed).length;
  const failedText = transcriptFailures(report);
  const failures = failedWindows + failedText;
  const agree = agreement(report);
  const busy = video.status === "running";
  return <section className="panel dock-panel">
    <header className="panel-head">
      <span className="video-head">
        <button type="button" className="link-button" onClick={() => onVideo(null)} aria-label="返回视频列表">←</button>
        <b className="v-name" title={video.path}>{video.name}</b><VideoTag video={video} />
      </span>
      <span className="head-tools">
        {all.length > 1 && <span className="chips" role="group" aria-label="显示模型组">
          {(["all", ...all] as string[]).map(id => <button key={id} type="button" className={filter === id ? "on" : undefined} aria-pressed={filter === id}
            onClick={() => onFilter(id)}>{id === "all" ? "全部" : providerLabel(id)}</button>)}
          {split.size > 0 && <button type="button" className={only === "split" ? "on" : "c-review"} aria-pressed={only === "split"}
            onClick={() => setOnly(x => x === "split" ? null : "split")} title="只看两组模型结论不一致的片段">分歧 {split.size}</button>}
        </span>}

        {report && <button type="button" className="link-button" disabled={preview} title={preview ? "演示模式没有报告文件" : `在文件夹中显示：${report.report_path}`}
          onClick={() => { setError(""); void onReveal(report.report_path).then(message => setError(message ?? "")); }}>报告 ↗</button>}
      </span>
    </header>
    {/* Actions: final decision, retries and re-runs on the prepared inputs */}
    <div className="toolbar">
      {report && <span className="decide" role="group" aria-label="人工终判">
        {VERDICTS.map(v => <button key={v.id} type="button" className={`d-${v.id}${video.review?.decision === v.id ? " on" : ""}`}
          aria-pressed={video.review?.decision === v.id} disabled={busy} onClick={() => onReview(video.id, video.review?.decision === v.id ? null : v.id)}>
          {v.zh}</button>)}
      </span>}
      {failures > 0 && !busy && <button type="button" className="tool" onClick={() => onRetryFailed(video.id)}
        title={failedText ? "重新发送失败的片段和全文判断" : undefined}>重试失败 {failures}</button>}
      {report && !busy && <button type="button" className={`tool${rerun ? " on" : ""}`} onClick={() => setRerun(r => r ? null : { provider: "both", modality: report.modality ?? "multimodal" })}>重新审核</button>}
      {busy && <button type="button" className="tool danger" onClick={() => onCancel(video.id)}>取消</button>}
      {semantic.size > 0 && <button type="button" className={`tool semantic-filter${only === "semantic" ? " on" : ""}`} aria-pressed={only === "semantic"}
        onClick={() => setOnly(x => x === "semantic" ? null : "semantic")} title="只看全文判断定位到的片段">全文定位 {semantic.size}</button>}
      {(video.status === "failed" || video.status === "cancelled") && <button type="button" className="tool" onClick={() => onRequeue(video.id)}>重新排队</button>}
    </div>
    {rerun && <div className="rerun">
      <select aria-label="模型组" value={rerun.provider} onChange={e => setRerun({ ...rerun, provider: e.target.value as Rerun["provider"] })}>
        <option value="both">JEV ＋ 对照</option><option value="jev">仅 JEV</option><option value="openai">仅对照</option></select>
      <select aria-label="输入模态" value={rerun.modality} onChange={e => setRerun({ ...rerun, modality: e.target.value as Rerun["modality"] })}>
        <option value="multimodal">画面＋转写</option><option value="visual">仅画面</option><option value="text">仅转写</option></select>
      <button type="button" className="tool primary-tool" onClick={() => { onRerun(video.id, rerun); setRerun(null); }}>开始（复用已准备的输入）</button>
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {video.status === "failed" ? <p className="notice v-failed">处理失败：{video.error}</p>
      : video.status === "cancelled" && !report ? <p className="empty">已取消</p>
      : !report ? <p className="empty">{busy ? "审核中…" : "排队中"}</p> : <>
        {failures > 0 && <p className="notice v-failed">
          {[failedWindows ? `${failedWindows} 段失败` : "", failedText ? "全文判断失败" : ""].filter(Boolean).join("，")}，已归入待定</p>}
        <FullText report={report} providers={providers} segment={segment} onSegment={onSegment} />
        <div className="table-scroll">
          <table>
            <thead><tr><th>#</th><th>时间</th>{providers.map(p => <th key={p}>{providerLabel(p)}</th>)}<th>峰值</th><th>主类</th></tr></thead>
            <tbody ref={body}>{segments.map(s => {
              const main = s.rows[providers[0]];
              const peak = Math.max(...providers.map(p => peakOf(s.rows[p])));
              const limits = thresholds(report);
              const offset = video.part?.start_sec ?? 0;
              const named = semantic.get(s.id);
              return <tr key={s.id} className={`${segment === s.id ? "on" : ""}${split.has(s.id) ? " split" : ""}${named ? " semantic" : ""}`}
                tabIndex={0} aria-selected={segment === s.id}
                onClick={() => onSegment(segment === s.id ? null : s.id)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSegment(segment === s.id ? null : s.id); } }}>
                <td className="num">{pad2(s.id)}{named && <i className="sem-mark"
                  title={`全文判断定位到本片段的语句：${[...named].map(c => categoryLabel(c, report)).join("、")}`} />}</td>
                <td className="num">{fmtTime(s.start + offset)}–{fmtTime(s.end + offset)}</td>
                {providers.map(p => <td key={p}><VerdictTag row={s.rows[p]} /></td>)}
                <td className={`num ${peak >= limits.block ? "t-block" : peak >= limits.review ? "t-review" : ""}`}>{peak.toFixed(3)}</td>
                <td>{s.verdict === "allow" ? "—" : topCategory(main && !isFailed(main) ? main : s.rows[providers[1]], report)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {agree != null && filter === "all" && <p className="table-foot">逐段一致率 {Math.round(agree * 100)}%{split.size ? ` · 分歧 ${split.size} 段` : ""}</p>}
      </>}
  </section>;
}
