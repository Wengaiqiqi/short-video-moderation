import { useEffect, useState } from "react";
import { VERDICTS, categoriesOf, categoryLabel, errorText, fmtTime, isFailed, isSkipped, pad2, providerLabel, thresholds,
         type SegmentView } from "../lib/report";
import { VerdictTag } from "./Results";
import type { ReviewDecision, SegmentEvidence, VideoItem, WorkerEvent } from "../types";

export type Request = (action: string, payload: Record<string, unknown>) => Promise<WorkerEvent>;

/** Frames and transcript of one window, fetched from the prepared inputs (cached per window). */
const evidenceCache = new Map<string, SegmentEvidence | string>();
export function useEvidence(video: VideoItem | null, segment: SegmentView | null, request: Request) {
  const key = video?.report && segment ? `${video.report.report_path}#${segment.id}` : "";
  const [state, setState] = useState<SegmentEvidence | string | null>(null);
  useEffect(() => {
    if (!key || !video?.report || !segment) { setState(null); return; }
    const cached = evidenceCache.get(key);
    if (cached) { setState(cached); return; }
    let alive = true;
    setState(null);
    void request("segment_evidence", { report_path: video.report.report_path, segment_id: segment.id,
                                       video_path: video.path, start_sec: segment.start, end_sec: segment.end }).then(answer => {
      const value = answer.error ? String(answer.error) : (answer as unknown as SegmentEvidence);
      evidenceCache.set(key, value);
      if (alive) setState(value);
    });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** A playable clip of the window (H.264 or VP8 cut by FFmpeg), as a blob URL. */
export function useClip(video: VideoItem | null, segment: SegmentView | null, request: Request) {
  const [clip, setClip] = useState<{ url?: string; error?: string; loading?: boolean }>({});
  useEffect(() => () => { if (clip.url) URL.revokeObjectURL(clip.url); }, [clip.url]);
  useEffect(() => { setClip({}); }, [video?.id, segment?.id]);
  async function load() {
    if (!video || !segment) return;
    setClip({ loading: true });
    const answer = await request("segment_clip", { video_path: video.path, start_sec: segment.start, end_sec: segment.end });
    if (answer.error || !answer.data) { setClip({ error: String(answer.error ?? "无法生成片段视频") }); return; }
    const bytes = Uint8Array.from(atob(String(answer.data)), c => c.charCodeAt(0));
    setClip({ url: URL.createObjectURL(new Blob([bytes], { type: String(answer.mime ?? "video/mp4") })) });
  }
  return { clip, load };
}

export function Scores({ video, segment, providers }: { video: VideoItem; segment: SegmentView; providers: string[] }) {
  const report = video.report ?? null;
  return <>{providers.map(provider => {
    const row = segment.rows[provider];
    if (!row) return null;
    return <div key={provider} className="detail-provider">
      <div className="detail-head"><b>{providerLabel(provider)}</b><VerdictTag row={row} />
        <span className="meta">{row.model ?? ""}{row.elapsed_sec != null ? ` · ${row.elapsed_sec.toFixed(2)}s` : ""}</span></div>
      {row.evidence === "asr_failed" && <p className="notice v-failed">语音识别失败，仅按画面判断</p>}
      {isSkipped(row) ? <p className="hint">{row.skip_reason === "stopped_after_block" ? "已命中拦截，未再送审"
          : `此窗口没有${row.skip_reason === "no_speech" ? "讲话" : row.skip_reason === "no_visual_evidence" ? "抽样画面" : "可审内容"}，未送审`}</p>
        : isFailed(row) ? <p className="notice v-failed">推理失败（{errorText(row.error_type)}），本段需人工复核</p>
        : categoriesOf(report).map(category => {
          const value = row.probabilities?.[category] ?? 0;
          const limits = thresholds(report, category);
          const tone = value >= limits.block ? "block" : value >= limits.review ? "review" : "allow";
          return <div key={category} className="score">
            <span className="score-name">{categoryLabel(category, report)}</span>
            <span className="score-bar"><i className={`v-${tone}`} style={{ width: `${value * 100}%` }} />
              <em style={{ left: `${limits.review * 100}%` }} /><em className="hi" style={{ left: `${limits.block * 100}%` }} /></span>
            <span className={`score-value t-${tone}`}>{value.toFixed(3)}</span>
          </div>;
        })}
    </div>;
  })}</>;
}

/** Compact evidence for the detail panel: a strip of frames and the transcript. */
export function EvidenceStrip({ evidence, onOpen, onPlay, clip }: {
  evidence: SegmentEvidence | string | null; onOpen: () => void; onPlay: () => void;
  clip: { url?: string; error?: string; loading?: boolean };
}) {
  if (evidence == null) return <p className="hint">读取画面与转写…</p>;
  if (typeof evidence === "string") return <p className="notice v-failed">{evidence}</p>;
  return <div className="evidence-strip">
    {clip.url ? <video className="clip" src={clip.url} controls autoPlay muted /> :
      <div className="frames-row">{evidence.frames.slice(0, 4).map(f => <img key={f.time_sec} src={f.data_url} alt={`${fmtTime(f.time_sec)} 画面`} title={fmtTime(f.time_sec)} />)}
        {!evidence.frames.length && <span className="hint">无抽样画面</span>}</div>}
    <p className="transcript">{evidence.speech_text || <span className="hint">（无讲话）</span>}</p>
    <div className="strip-actions">
      <button type="button" className="tool" onClick={onOpen}>放大查看</button>
      {!clip.url && <button type="button" className="tool" onClick={onPlay} disabled={clip.loading}>{clip.loading ? "生成中…" : "播放片段"}</button>}
      {clip.error && <span className="hint warn">{clip.error}</span>}
    </div>
  </div>;
}

/** Full-size evidence of one window with its scores; ← → move between windows, Esc closes. */
export function EvidenceModal({ video, segments, segment, providers, request, onSegment, onClose, onReview }: {
  video: VideoItem; segments: SegmentView[]; segment: SegmentView; providers: string[]; request: Request;
  onSegment: (id: number) => void; onClose: () => void; onReview: (decision: ReviewDecision["decision"] | null) => void;
}) {
  const evidence = useEvidence(video, segment, request);
  const { clip, load } = useClip(video, segment, request);
  const [frame, setFrame] = useState(0);
  useEffect(() => { setFrame(0); }, [segment.id]);
  const index = segments.findIndex(s => s.id === segment.id);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index + 1 < segments.length) onSegment(segments[index + 1].id);
      if (e.key === "ArrowLeft" && index > 0) onSegment(segments[index - 1].id);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [index, segments, onClose, onSegment]);
  const pictures = typeof evidence === "object" && evidence ? evidence.frames : [];
  const offset = video.part?.start_sec ?? 0;
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal evidence-modal" role="dialog" aria-modal="true" aria-label={`片段 ${pad2(segment.id)} 证据`} onClick={e => e.stopPropagation()}>
      <header className="modal-head">
        <b>片段 {pad2(segment.id)}</b><span className="meta">{video.name} · {fmtTime(segment.start + offset)}–{fmtTime(segment.end + offset)}</span>
        <span className="head-tools">
          <button type="button" className="link-button" disabled={index <= 0} onClick={() => onSegment(segments[index - 1].id)}>← 上一段</button>
          <button type="button" className="link-button" disabled={index + 1 >= segments.length} onClick={() => onSegment(segments[index + 1].id)}>下一段 →</button>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>×</button>
        </span>
      </header>
      <div className="modal-body">
        <div className="stage-view">
          {clip.url ? <video className="clip big" src={clip.url} controls autoPlay /> :
            pictures[frame] ? <img className="big" src={pictures[frame].data_url} alt="" /> :
            <div className="big placeholder">{evidence == null ? "读取中…" : typeof evidence === "string" ? evidence : "无抽样画面"}</div>}
          <div className="thumbs">
            {pictures.map((f, i) => <button key={f.time_sec} type="button" className={i === frame && !clip.url ? "on" : undefined}
              onClick={() => { setFrame(i); }} title={fmtTime(f.time_sec + offset)}><img src={f.data_url} alt="" /></button>)}
            {!clip.url && <button type="button" className="tool" onClick={() => void load()} disabled={clip.loading}>{clip.loading ? "生成中…" : "▶ 播放片段"}</button>}
          </div>
          {clip.error && <p className="hint warn">{clip.error}</p>}
          <p className="transcript big-text">{typeof evidence === "object" && evidence ? (evidence.speech_text || "（无讲话）") : ""}</p>
        </div>
        <aside className="modal-side">
          <span className="decide" role="group" aria-label="人工终判">
            {VERDICTS.map(v => <button key={v.id} type="button" className={`d-${v.id}${video.review?.decision === v.id ? " on" : ""}`}
              onClick={() => onReview(video.review?.decision === v.id ? null : v.id)}>{v.zh}</button>)}
          </span>
          <Scores video={video} segment={segment} providers={providers} />
        </aside>
      </div>
    </div>
  </div>;
}
