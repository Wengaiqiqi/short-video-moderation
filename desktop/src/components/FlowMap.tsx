import { useEffect, useMemo, useRef, useState } from "react";
import { useSize } from "../lib/useSize";
import { VERDICTS, VERDICT_ZH, finalVerdict, phaseOf, providerLabel, stageProgress, type Phase, type Verdict } from "../lib/report";
import type { Stages } from "../useModeration";
import type { StageState, VideoItem } from "../types";

interface Props {
  videos: VideoItem[];
  stagesById: Record<string, Stages>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  bin: Verdict | null;
  onBin: (bin: Verdict | null) => void;
  meta: { interval: number; segmentSeconds: number; asr: string; cloud: boolean };
}

/** A finished video: tile → both stage lines → merge into 分类判断 → its bin. */
const EXIT_MS = 2000;
/** A video entering classification: light runs from both stage lines into 分类判断. */
const ENTER_MS = 1200;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Slot { x: number; y: number }

/** Fixed-size square slots packed row by row inside the half-disc, like stacking blocks. */
function packSlots(cx: number, cy: number, R: number, size: number, gap: number) {
  const inset = 8;
  const pitch = size + gap;
  const rows = Math.floor((2 * (R - inset) + gap) / pitch);
  const offset = (2 * (R - inset) + gap - rows * pitch) / 2;
  const slots: Slot[] = [];
  for (let r = 0; r < rows; r++) {
    const y = cy - R + inset + offset + r * pitch;
    const dy = Math.max(Math.abs(y - cy), Math.abs(y + size - cy));
    if (dy >= R) continue;
    const x0 = cx + 6;
    const room = cx + Math.sqrt(R * R - dy * dy) - inset - x0;
    const count = Math.floor((room + gap) / pitch);
    for (let k = 0; k < count; k++) slots.push({ x: x0 + k * pitch, y });
  }
  return slots;
}

function runningLabel(stages?: Stages) {
  if (!stages) return "准备中";
  if (stages.prepare.state === "run") return stages.prepare.total ? `转写 ${stages.prepare.done ?? 0}/${stages.prepare.total}` : "抽帧 ∥ 转写";
  if (stages.align.state === "run") return "对齐窗口";
  const parts = (["jev", "openai"] as const).filter(p => stages[p].state === "run" || stages[p].state === "pass")
    .map(p => `${providerLabel(p)} ${stages[p].done ?? 0}/${stages[p].total ?? "?"}`);
  return parts.length ? parts.join(" · ") : "准备中";
}

/**
 * A glowing streak travelling once (or looping) along a path: a long faint tail, a coloured glow and
 * a white-hot head. All layers share the same leading edge (see the `comet` keyframes).
 */
function Comet({ d, tone, delay = 0, duration, loop = false, width = 1 }: {
  d: string; tone: string; delay?: number; duration: number; loop?: boolean; width?: number;
}) {
  const timing = { animationDelay: `${delay}ms`, animationDuration: `${duration}ms`, animationIterationCount: loop ? "infinite" : 1 };
  const layer = (cls: string, stroke: number) =>
    <path d={d} pathLength={1} className={cls} style={{ ...timing, strokeWidth: stroke * width }} />;
  return <g className={`comet t-${tone}${loop ? " loop" : ""}`}>
    {layer("comet-tail", 2.2)}
    {layer("comet-halo", 7)}
    {layer("comet-core", 2.2)}
  </g>;
}

const STATE_TEXT: Record<StageState, string> = { wait: "WAIT", run: "RUN", pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export default function FlowMap({ videos, stagesById, selected, onSelect, bin, onBin, meta }: Props) {
  const [box, { width: W, height: H }] = useSize<HTMLDivElement>();
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(t => window.clearTimeout(t)), []);
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };

  // Finished videos stay in the disc while their light travels to the bin.
  const [exiting, setExiting] = useState<Record<string, number>>({});
  // Videos that just entered classification (one burst each).
  const [entering, setEntering] = useState<Record<string, number>>({});
  const seenStatus = useRef(new Map<string, string>());
  const seenPhase = useRef(new Map<string, Phase>());
  useEffect(() => {
    const now = Date.now();
    const exits: string[] = [];
    const enters: string[] = [];
    for (const v of videos) {
      const before = seenStatus.current.get(v.id);
      if (before && before !== v.status && (v.status === "done" || v.status === "failed")) exits.push(v.id);
      seenStatus.current.set(v.id, v.status);
      if (v.status === "running") {
        const phase = phaseOf(stagesById[v.id]);
        if (phase === "classify" && seenPhase.current.get(v.id) !== "classify") enters.push(v.id);
        seenPhase.current.set(v.id, phase);
      }
    }
    if (exits.length) {
      setExiting(e => ({ ...e, ...Object.fromEntries(exits.map(id => [id, now])) }));
      later(EXIT_MS, () => setExiting(e => { const n = { ...e }; exits.forEach(id => delete n[id]); return n; }));
    }
    if (enters.length) {
      setEntering(e => ({ ...e, ...Object.fromEntries(enters.map(id => [id, now])) }));
      later(ENTER_MS, () => setEntering(e => { const n = { ...e }; enters.forEach(id => delete n[id]); return n; }));
    }
  }, [videos, stagesById]); // eslint-disable-line react-hooks/exhaustive-deps

  const inDisc = videos.filter(v => v.status === "queued" || v.status === "running" || exiting[v.id]);
  // Bins show this batch (history stays in the results list); a reviewer's final decision moves a video.
  const landed = videos.filter(v => (v.status === "done" || v.status === "failed") && !exiting[v.id] && !v.history);
  const runningVideos = videos.filter(v => v.status === "running");
  const phases = runningVideos.map(v => phaseOf(stagesById[v.id]));
  const preparing = phases.filter(p => p === "prepare" || p === "queued").length;
  const asrBusy = phases.filter(p => p === "prepare" || p === "align" || p === "queued").length;
  const classifying = phases.filter(p => p === "classify").length;
  const anyDone = landed.length > 0;
  const anyWarn = landed.some(v => v.status === "failed" || Object.values(v.report?.providers ?? {}).some(p => !p.complete));
  const state = {
    frames: (preparing ? "run" : anyDone ? "pass" : "wait") as StageState,
    asr: (asrBusy ? "run" : anyDone ? "pass" : "wait") as StageState,
    classify: (classifying ? "run" : anyDone ? (anyWarn ? "warn" : "pass") : "wait") as StageState,
  };

  const geometry = useMemo(() => {
    if (W < 240 || H < 200) return null;
    const binW = clamp(W * 0.19, 160, 240);
    const binX = W - binW - 12;
    const R = Math.min(H / 2 - 10, (W - binW) * 0.38);
    const cx = 10, cy = H / 2;
    const size = clamp(Math.round(R / 3.6), 44, 78);
    const slots = packSlots(cx, cy, R, size, 6);
    // Stage boxes sit centred between the disc and the bins; the merge arcs bulge to their left.
    const left = cx + R + clamp(W * 0.06, 44, 70), right = binX - clamp(W * 0.045, 30, 50);
    const midW = clamp(right - left, 130, 300);
    const midX = left + Math.max(0, (right - left - midW) / 2);
    const spacing = clamp(H * 0.23, 70, 124);
    const y = { top: cy - spacing, mid: cy, bot: cy + spacing };
    const edgeX = (yy: number) => cx + Math.sqrt(Math.max(0, R * R - (yy - cy) * (yy - cy)));
    const binGap = 10, margin = 12;
    const binH = (H - 2 * margin - 2 * binGap) / 3;
    const bins = Object.fromEntries(VERDICTS.map((v, i) => [v.id, { x: binX, y: margin + i * (binH + binGap), w: binW, h: binH }])) as Record<Verdict, { x: number; y: number; w: number; h: number }>;
    const bulge = Math.min(54, midX - (cx + R) - 14);
    const xIn = midX - 2, xOut = midX + midW + 2;
    const paths = {
      inTop: `M${edgeX(y.top) + 2},${y.top} L${xIn},${y.top}`,
      inBot: `M${edgeX(y.bot) + 2},${y.bot} L${xIn},${y.bot}`,
      // Merge arcs leave the side boxes just beside the incoming arrow so the two never overlap.
      mergeTop: `M${xIn},${y.top + 11} C${xIn - bulge},${y.top + 11} ${xIn - bulge},${y.mid - 8} ${xIn},${y.mid - 8}`,
      mergeBot: `M${xIn},${y.bot - 11} C${xIn - bulge},${y.bot - 11} ${xIn - bulge},${y.mid + 8} ${xIn},${y.mid + 8}`,
      out: Object.fromEntries(VERDICTS.map(v => {
        const b = bins[v.id], by = b.y + b.h / 2;
        return [v.id, `M${xOut},${y.mid} C${xOut + 70},${y.mid} ${b.x - 70},${by} ${b.x - 2},${by}`];
      })) as Record<Verdict, string>,
    };
    return { binW, binX, R, cx, cy, size, slots, midX, midW, y, bins, edgeX, paths, xIn };
  }, [W, H]);

  const placed = useMemo(() => {
    if (!geometry) return [];
    const capacity = geometry.slots.length;
    const shown = inDisc.length > capacity ? inDisc.slice(0, Math.max(0, capacity - 1)) : inDisc;
    return shown.map((video, i) => ({ video, slot: geometry.slots[i] }));
  }, [geometry, inDisc]);
  const hidden = geometry ? Math.max(0, inDisc.length - placed.length) : 0;

  return <div className="flow" ref={box}>
    {geometry && <svg width={W} height={H} aria-hidden="true">
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {/* Arrowheads, one per rail colour; the tip sits exactly at the end of the line */}
        {["wait", "run", "pass", "warn", "fail", "skip", "allow", "block", "review"].map(k =>
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="8" markerHeight="8"
            markerUnits="userSpaceOnUse" orient="auto">
            <path d="M0,0.8 L10,5 L0,9.2 L2.6,5 Z" className={`arrow-head a-${k}`} />
          </marker>)}
      </defs>
      <path className="disc-halo" d={`M${geometry.cx},${geometry.cy - geometry.R - 14} A${geometry.R + 14},${geometry.R + 14} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R + 14}`} />
      <path className="disc-edge" d={`M${geometry.cx},${geometry.cy - geometry.R} A${geometry.R},${geometry.R} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R}`} />
      {geometry.slots.map((s, i) => <rect key={i} className="slot" x={s.x} y={s.y} width={geometry.size} height={geometry.size} rx={9} />)}

      {/* Rails: disc → 画面切分 / 语音识别 (in parallel) → merge into 分类判断 → three bins */}
      <path className={`rail s-${state.frames}`} d={geometry.paths.inTop} markerEnd={`url(#arrow-${state.frames})`} />
      <path className={`rail s-${state.asr}`} d={geometry.paths.inBot} markerEnd={`url(#arrow-${state.asr})`} />
      <path className={`rail merge s-${state.classify}`} d={geometry.paths.mergeTop} markerEnd={`url(#arrow-${state.classify})`} />
      <path className={`rail merge s-${state.classify}`} d={geometry.paths.mergeBot} markerEnd={`url(#arrow-${state.classify})`} />
      {VERDICTS.map(v => <path key={v.id} className={`rail out v-${v.id}`} d={geometry.paths.out[v.id]} markerEnd={`url(#arrow-${v.id})`} />)}

      <g>
        {/* Ambient light while work is in a stage */}
        {preparing > 0 && <Comet d={geometry.paths.inTop} tone="data" duration={1500} loop width={0.7} />}
        {asrBusy > 0 && <Comet d={geometry.paths.inBot} tone="data" duration={1500} delay={500} loop width={0.7} />}
        {classifying > 0 && <>
          <Comet d={geometry.paths.mergeTop} tone="data" duration={1300} loop width={0.8} />
          <Comet d={geometry.paths.mergeBot} tone="data" duration={1300} delay={650} loop width={0.8} />
          {VERDICTS.map((v, i) => <Comet key={v.id} d={geometry.paths.out[v.id]} tone={v.id} duration={1600} delay={1300 + i * 400} loop width={0.8} />)}
        </>}
        {/* Burst: a video enters classification — both lines pour into 分类判断 */}
        {Object.entries(entering).map(([id, at]) => <g key={`enter-${id}-${at}`}>
          <Comet d={geometry.paths.mergeTop} tone="hot" duration={900} width={1.3} />
          <Comet d={geometry.paths.mergeBot} tone="hot" duration={900} width={1.3} />
        </g>)}
        {/* Burst: a video finishes — tile → both rails → merge → its bin */}
        {placed.filter(p => exiting[p.video.id]).map(({ video, slot }) => {
          const verdict = finalVerdict(video) ?? "review";
          const x0 = slot.x + geometry.size / 2, y0 = slot.y + geometry.size / 2;
          const toRail = (yy: number) => `M${x0},${y0} C${(x0 + geometry.xIn) / 2},${y0} ${geometry.xIn - 80},${yy} ${geometry.xIn},${yy}`;
          const tone = video.status === "failed" ? "failed" : verdict;
          return <g key={`exit-${video.id}-${exiting[video.id]}`}>
            <Comet d={toRail(geometry.y.top)} tone="data" duration={650} width={1.1} />
            <Comet d={toRail(geometry.y.bot)} tone="data" duration={650} width={1.1} />
            <Comet d={geometry.paths.mergeTop} tone="hot" delay={560} duration={520} width={1.3} />
            <Comet d={geometry.paths.mergeBot} tone="hot" delay={560} duration={520} width={1.3} />
            <Comet d={geometry.paths.out[verdict]} tone={tone} delay={1040} duration={800} width={1.6} />
          </g>;
        })}
      </g>
    </svg>}

    {geometry && <>
      {placed.length === 0 && <div className="disc-note" style={{ left: geometry.cx + geometry.R * 0.1, top: geometry.cy - 26, width: geometry.R * 0.82 }}>
        {landed.length ? <><b>QUEUE CLEAR</b><span>{landed.length} 个已归类</span></> : <><b>NO INPUT</b><span>等待视频</span></>}
      </div>}

      {placed.map(({ video, slot }) => {
        const leaving = !!exiting[video.id];
        const stages = stagesById[video.id];
        const cls = `tile ${leaving ? `exiting v-${video.status === "failed" ? "failed" : finalVerdict(video)}` : video.status}${selected === video.id ? " selected" : ""}`;
        return <button key={video.id} type="button" className={cls} style={{ left: slot.x, top: slot.y, width: geometry.size, height: geometry.size }}
          title={`${video.name}${video.status === "queued" ? " · 排队中" : video.status === "running" ? " · 审核中" : ""}`}
          onClick={() => onSelect(selected === video.id ? null : video.id)}>
          {video.thumb ? <img src={video.thumb} alt="" draggable={false} /> : <span className="tile-ph">{video.name.slice(0, 2)}</span>}
          {geometry.size >= 54 && <span className="tile-name">{video.name}</span>}
          {video.status === "running" && !leaving && <>
            <span className="tile-scan" />
            <span className="tile-state">{runningLabel(stages)}</span>
            <span className="tile-progress"><i style={{ width: `${(stages ? stageProgress(stages) : 0) * 100}%` }} /></span>
          </>}
          {leaving && <span className="tile-verdict">{video.status === "failed" ? "失败" : VERDICT_ZH[finalVerdict(video) ?? "review"]}</span>}
        </button>;
      })}
      {hidden > 0 && (() => {
        const slot = geometry.slots[geometry.slots.length - 1];
        return <div className="tile more" style={{ left: slot.x, top: slot.y, width: geometry.size, height: geometry.size }}>+{hidden + 1}</div>;
      })()}

      {/* Stages: 画面切分 (top) and 语音识别 (bottom) run in parallel and merge into 分类判断 (middle) */}
      {[
        { key: "frames" as const, no: "01", zh: "画面切分", en: "FRAME SPLIT", y: geometry.y.top, tall: false,
          sub: `${meta.interval}s · 场景补帧`, count: preparing },
        { key: "classify" as const, no: "03", zh: "分类判断", en: "CLASSIFY", y: geometry.y.mid, tall: true,
          sub: `≤${meta.segmentSeconds}s 窗口 · 取最严`, count: classifying },
        { key: "asr" as const, no: "02", zh: "语音识别", en: "ASR", y: geometry.y.bot, tall: false,
          sub: meta.cloud ? `${meta.asr} · 静音切分` : meta.asr, count: asrBusy },
      ].map(stage => {
        const s = state[stage.key];
        return <div key={stage.key} className={`stage s-${s}${stage.tall ? " hub" : ""}${s === "run" && stage.tall ? " hot" : ""}${geometry.midW < 230 ? " compact" : geometry.midW < 330 ? " snug" : ""}`}
          style={{ left: geometry.midX, top: stage.y - (stage.tall ? 29 : 25), width: geometry.midW }}>
          <span className="stage-no">{stage.no}</span>
          <div className="stage-body">
            <div className="stage-title"><b>{stage.zh}</b><em>{stage.en}</em></div>
            <div className="stage-sub">{stage.sub}</div>
          </div>
          <span className="stage-state" title={STATE_TEXT[s]}><i />{s === "run" ? stage.count : ""}</span>
        </div>;
      })}

      {/* Verdict bins hold finished videos; click a bin to list them, a cover to open that video */}
      {VERDICTS.map(v => {
        const b = geometry.bins[v.id];
        const items = landed.filter(x => finalVerdict(x) === v.id);
        const failed = items.filter(x => x.status === "failed").length;
        // Cover grid: 6 per row inside the bin padding; show as many whole rows as fit.
        const thumb = clamp(Math.floor((b.w - 32 - 5 * 5) / 6), 18, 30);
        const fit = Math.max(0, Math.floor((b.h - 96 + 5) / (thumb + 5))) * 6;
        const shown = items.length > fit ? items.slice(-(Math.max(0, fit - 1))) : items;
        return <div key={v.id} className={`bin v-${v.id}${bin === v.id ? " on" : ""}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
          <button type="button" className="bin-hit" aria-pressed={bin === v.id} onClick={() => onBin(bin === v.id ? null : v.id)}
            aria-label={`${v.zh}：${items.length} 个视频，点击查看列表`} />
          <div className="bin-head"><span className="bin-en">{v.en}</span><span className="bin-count">×{items.length}</span></div>
          <div className="bin-zh">{v.zh}{failed > 0 && <small className="bin-failed">失败 {failed}</small>}</div>
          <div className="bin-thumbs">
            {items.length > shown.length && <span className="bin-more" style={{ width: thumb, height: thumb }}>+{items.length - shown.length}</span>}
            {shown.map(x => <button key={x.id} type="button" className={`bin-thumb${selected === x.id ? " selected" : ""}${x.status === "failed" ? " failed" : ""}${x.review ? " reviewed" : ""}`}
              style={{ width: thumb, height: thumb }} title={x.name} onClick={() => onSelect(x.id)}>
              {x.thumb ? <img src={x.thumb} alt={x.name} draggable={false} /> : <span>{x.name.slice(0, 1)}</span>}
            </button>)}
          </div>
        </div>;
      })}

    </>}
  </div>;
}
