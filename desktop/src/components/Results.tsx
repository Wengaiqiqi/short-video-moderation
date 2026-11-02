import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  VERDICTS, VERDICT_ZH, agreement, categoryLabel, errorText, fmtDuration, fmtTime, isFailed, isSkipped, pad2, peakOf, providerLabel, providersOf,
  segmentsOf, tally, thresholds, verdictOf, visibleProviders, type ProviderFilter, type SegmentView, type Verdict,
} from "../lib/report";
import type { ModerationRow, VideoItem } from "../types";

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
  if (video.status === "failed") return <span className="vtag v-failed" title={video.error}>处理失败·待定</span>;
  return <span className={`vtag v-${video.verdict}`}>{VERDICT_ZH[video.verdict ?? "review"]}</span>;
}

function topCategory(row?: ModerationRow) {
  const entries = Object.entries(row?.probabilities ?? {});
  if (!entries.length) return "—";
  return categoryLabel(entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0]);
}

interface Props {
  videos: VideoItem[]; video: VideoItem | null; onVideo: (id: string | null) => void;
  bin: Verdict | null; onBin: (bin: Verdict | null) => void;
  segment: number | null; onSegment: (id: number | null) => void;
  filter: ProviderFilter; onFilter: (filter: ProviderFilter) => void;
  preview: boolean;
}

/** Finished videos (filtered by bin); opening one shows its per-window verdicts. */
export default function Results(props: Props) {
  return props.video ? <VideoSegments {...props} video={props.video} /> : <VideoList {...props} />;
}

function VideoList({ videos, onVideo, bin, onBin }: Props) {
  const finished = videos.filter(v => v.status === "done" || v.status === "failed");
  const rows = bin ? finished.filter(v => v.verdict === bin) : finished;
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>RESULTS</b> · 视频结果</span>
      <span className="chips" role="group" aria-label="按判定筛选">
        <button type="button" className={!bin ? "on" : undefined} aria-pressed={!bin} onClick={() => onBin(null)}>全部 {finished.length}</button>
        {VERDICTS.map(v => <button key={v.id} type="button" className={`c-${v.id}${bin === v.id ? " on" : ""}`} aria-pressed={bin === v.id}
          onClick={() => onBin(bin === v.id ? null : v.id)}>{v.zh} {finished.filter(x => x.verdict === v.id).length}</button>)}
      </span>
    </header>
    {rows.length === 0 ? <p className="empty">{finished.length ? "这一类还没有视频。" : "暂无结果。视频审核完成后会落入右侧判定格，并列在这里；点击查看逐段结果。"}</p> :
      <div className="table-scroll">
        <table>
          <thead><tr><th>视频</th><th>结论</th><th>片段</th><th>拦截段</th><th>待定段</th><th>用时</th></tr></thead>
          <tbody>{[...rows].reverse().map(v => {
            const counts = tally(v.report, providersOf(v.report));
            const sum = (k: "block" | "review") => Object.values(counts).reduce((a, c) => a + c[k], 0);
            const segments = Math.max(0, ...Object.values(v.report?.providers ?? {}).map(p => p.segments.length));
            return <tr key={v.id} tabIndex={0} onClick={() => onVideo(v.id)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onVideo(v.id); } }}>
              <td className="video-cell"><span className="q-thumb">{v.thumb ? <img src={v.thumb} alt="" /> : null}</span><span className="v-name" title={v.path}>{v.name}</span></td>
              <td><VideoTag video={v} /></td>
              <td className="num">{v.report ? segments : "—"}</td>
              <td className={`num${sum("block") ? " t-block" : ""}`}>{v.report ? sum("block") : "—"}</td>
              <td className={`num${sum("review") ? " t-review" : ""}`}>{v.report ? sum("review") : "—"}</td>
              <td className="num">{v.startedAt && v.finishedAt ? fmtDuration(v.finishedAt - v.startedAt) : "—"}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </section>;
}

function VideoSegments({ video, onVideo, segment, onSegment, filter, onFilter, preview }: Props & { video: VideoItem }) {
  const [error, setError] = useState("");
  const body = useRef<HTMLTableSectionElement>(null);
  useEffect(() => { body.current?.querySelector("tr.on")?.scrollIntoView({ block: "nearest" }); }, [segment]);
  const report = video.report ?? null;
  const all = providersOf(report);
  const providers = visibleProviders(report, filter);
  const segments: SegmentView[] = segmentsOf(report, providers);
  const limits = thresholds(report);
  const failures = segments.filter(s => s.failed).length;
  const agree = agreement(report);
  return <section className="panel dock-panel">
    <header className="panel-head">
      <span className="video-head">
        <button type="button" className="link-button" onClick={() => onVideo(null)} aria-label="返回视频列表">← 列表</button>
        <b className="v-name" title={video.path}>{video.name}</b><VideoTag video={video} />
      </span>
      <span className="head-tools">
        {all.length > 1 && <span className="chips" role="group" aria-label="显示模型组">
          {(["all", ...all] as string[]).map(id => <button key={id} type="button" className={filter === id ? "on" : undefined} aria-pressed={filter === id}
            onClick={() => onFilter(id)}>{id === "all" ? "全部" : providerLabel(id)}</button>)}
        </span>}
        {report && <button type="button" className="link-button" disabled={preview} title={preview ? "DEMO 预览没有报告文件" : report.report_path}
          onClick={() => { setError(""); void openPath(report.report_path).catch(e => setError(String(e))); }}>报告 ↗</button>}
      </span>
    </header>
    {error && <p className="form-error" role="alert">{error}</p>}
    {video.status === "failed" ? <p className="notice v-failed">整段处理失败：{video.error}。已归入「待定」，需人工复核或重新审核。</p>
      : !report ? <p className="empty">{video.status === "running" ? "审核中，完成后在这里显示逐段结果。" : "排队中，尚未审核。"}</p> : <>
        {failures > 0 && <p className="notice v-failed">{failures} 个片段推理失败，已归入「待定」，需人工复核。</p>}
        <div className="table-scroll">
          <table>
            <thead><tr><th>#</th><th>时间</th>{providers.map(p => <th key={p}>{providerLabel(p)}</th>)}<th>峰值</th><th>主类</th></tr></thead>
            <tbody ref={body}>{segments.map(s => {
              const main = s.rows[providers[0]];
              const peak = Math.max(...providers.map(p => peakOf(s.rows[p])));
              return <tr key={s.id} className={segment === s.id ? "on" : undefined} tabIndex={0} aria-selected={segment === s.id}
                onClick={() => onSegment(segment === s.id ? null : s.id)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSegment(segment === s.id ? null : s.id); } }}>
                <td className="num">{pad2(s.id)}</td>
                <td className="num">{fmtTime(s.start)}–{fmtTime(s.end)}</td>
                {providers.map(p => <td key={p}><VerdictTag row={s.rows[p]} /></td>)}
                <td className={`num ${peak >= limits.block ? "t-block" : peak >= limits.review ? "t-review" : ""}`}>{peak.toFixed(3)}</td>
                <td>{topCategory(main && !isFailed(main) ? main : s.rows[providers[1]])}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {agree != null && filter === "all" && <p className="table-foot">JEV 与对照组逐段一致率 {Math.round(agree * 100)}%</p>}
      </>}
  </section>;
}
