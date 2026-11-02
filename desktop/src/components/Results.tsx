import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  VERDICTS, VERDICT_ZH, agreement, categoryLabel, disagreements, errorText, finalVerdict, fmtDuration, fmtTime, isFailed, isSkipped,
  pad2, peakOf, providerLabel, providersOf, segmentsOf, tally, thresholds, verdictOf, visibleProviders,
  type ProviderFilter, type SegmentView, type Verdict,
} from "../lib/report";
import type { ModerationReport, ModerationRequest, ModerationRow, ReviewDecision, VideoItem } from "../types";

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
  return <span className={`vtag v-${verdict}`} title={video.review ? `人工终判（模型：${VERDICT_ZH[video.verdict ?? "review"]}）` : undefined}>
    {VERDICT_ZH[verdict]}{video.review ? " · 人工" : ""}</span>;
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
    <header className="panel-head"><span><b>RESULTS</b></span>
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

function VideoSegments({ video, onVideo, segment, onSegment, filter, onFilter, preview, onReview, onRetryFailed, onRerun, onCancel, onRequeue }: Props & { video: VideoItem }) {
  const [error, setError] = useState("");
  const [onlySplit, setOnlySplit] = useState(false);
  const [rerun, setRerun] = useState<Rerun | null>(null);
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => { body.current?.querySelector("tr.on")?.scrollIntoView({ block: "nearest" }); }, [segment]);
  useEffect(() => { setOnlySplit(false); setRerun(null); }, [video.id]);
  const report = video.report ?? null;
  const all = providersOf(report);
  const providers = visibleProviders(report, filter);
  const split = disagreements(report);
  const segments: SegmentView[] = segmentsOf(report, providers).filter(s => !onlySplit || split.has(s.id));
  const failures = segmentsOf(report, all).filter(s => s.failed).length;
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
          {split.size > 0 && <button type="button" className={onlySplit ? "on" : "c-review"} aria-pressed={onlySplit}
            onClick={() => setOnlySplit(x => !x)} title="只看两组模型结论不一致的片段">分歧 {split.size}</button>}
        </span>}
        {report && <button type="button" className="link-button" disabled={preview} title={preview ? "DEMO 预览没有报告文件" : report.report_path}
          onClick={() => { setError(""); void openPath(report.report_path).catch(e => setError(String(e))); }}>报告 ↗</button>}
      </span>
    </header>
    {/* Actions: final decision, retries and re-runs on the prepared inputs */}
    <div className="toolbar">
      {report && <span className="decide" role="group" aria-label="人工终判">
        {VERDICTS.map(v => <button key={v.id} type="button" className={`d-${v.id}${video.review?.decision === v.id ? " on" : ""}`}
          aria-pressed={video.review?.decision === v.id} disabled={busy} onClick={() => onReview(video.id, video.review?.decision === v.id ? null : v.id)}>
          {v.zh}</button>)}
      </span>}
      {failures > 0 && !busy && <button type="button" className="tool" onClick={() => onRetryFailed(video.id)}>重试失败段 {failures}</button>}
      {report && !busy && <button type="button" className={`tool${rerun ? " on" : ""}`} onClick={() => setRerun(r => r ? null : { provider: "both", modality: report.modality ?? "multimodal" })}>重新审核</button>}
      {busy && <button type="button" className="tool danger" onClick={() => onCancel(video.id)}>取消</button>}
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
        {failures > 0 && <p className="notice v-failed">{failures} 段失败，已归入待定</p>}
        <div className="table-scroll">
          <table>
            <thead><tr><th>#</th><th>时间</th>{providers.map(p => <th key={p}>{providerLabel(p)}</th>)}<th>峰值</th><th>主类</th></tr></thead>
            <tbody ref={body}>{segments.map(s => {
              const main = s.rows[providers[0]];
              const peak = Math.max(...providers.map(p => peakOf(s.rows[p])));
              const limits = thresholds(report);
              const offset = video.part?.start_sec ?? 0;
              return <tr key={s.id} className={`${segment === s.id ? "on" : ""}${split.has(s.id) ? " split" : ""}`} tabIndex={0} aria-selected={segment === s.id}
                onClick={() => onSegment(segment === s.id ? null : s.id)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSegment(segment === s.id ? null : s.id); } }}>
                <td className="num">{pad2(s.id)}</td>
                <td className="num">{fmtTime(s.start + offset)}–{fmtTime(s.end + offset)}</td>
                {providers.map(p => <td key={p}><VerdictTag row={s.rows[p]} /></td>)}
                <td className={`num ${peak >= limits.block ? "t-block" : peak >= limits.review ? "t-review" : ""}`}>{peak.toFixed(3)}</td>
                <td>{topCategory(main && !isFailed(main) ? main : s.rows[providers[1]], report)}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {agree != null && filter === "all" && <p className="table-foot">逐段一致率 {Math.round(agree * 100)}%{split.size ? ` · 分歧 ${split.size} 段` : ""}</p>}
      </>}
  </section>;
}
