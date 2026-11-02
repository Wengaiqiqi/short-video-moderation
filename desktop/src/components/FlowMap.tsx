import { useEffect, useMemo, useRef, useState } from "react";
import { useSize } from "../lib/useSize";
import { VERDICTS, VERDICT_ZH, isFailed, providerLabel, stageProgress, verdictOf, type Verdict } from "../lib/report";
import type { Stage, StageId, StageState, VideoItem } from "../types";

interface Props {
  videos: VideoItem[];
  stages: Record<StageId, Stage>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  bin: Verdict | null;
  onBin: (bin: Verdict | null) => void;
  meta: { interval: number; segmentSeconds: number; asr: string; cloud: boolean };
}

/** How long a finished video takes to dissolve into lines and reach its bin. */
const EXIT_MS = 1900;
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

function stageStates(stages: Record<StageId, Stage>, running: boolean) {
  const { prepare, align, jev, openai } = stages;
  const asr: StageState = prepare.state === "run" || align.state === "run" ? "run"
    : prepare.state === "fail" || align.state === "fail" ? "fail" : align.state === "pass" ? "pass" : "wait";
  let classify: StageState = "wait";
  if (jev.state === "fail" || openai.state === "fail") classify = "fail";
  else if (jev.state === "run" || openai.state === "run") classify = "run";
  else if ([jev, openai].some(s => s.state === "warn")) classify = "warn";
  else if ([jev, openai].some(s => s.state === "pass")) classify = "pass";
  const provider = jev.state === "run" ? jev : openai.state === "run" ? openai : null;
  const out = { frames: prepare.state as StageState, asr, classify, provider, aligning: align.state === "run" };
  if (!running && out.frames === "skip") out.frames = "wait";
  return out;
}

function runningLabel(stages: Record<StageId, Stage>) {
  if (stages.prepare.state === "run") return "抽帧 ∥ 转写";
  if (stages.align.state === "run") return "对齐窗口";
  const p = stages.jev.state === "run" ? stages.jev : stages.openai.state === "run" ? stages.openai : null;
  if (p) return `${providerLabel(p.id)} ${(p.done ?? 0) + 1}/${p.total}`;
  return "准备中";
}

const STATE_TEXT: Record<StageState, string> = { wait: "WAIT", run: "RUN", pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export default function FlowMap({ videos, stages, selected, onSelect, bin, onBin, meta }: Props) {
  const [box, { width: W, height: H }] = useSize<HTMLDivElement>();

  // Videos that just finished stay in the disc while they dissolve into the bins.
  const [exiting, setExiting] = useState<Record<string, number>>({});
  const seen = useRef(new Map<string, string>());
  const timers = useRef<number[]>([]);
  useEffect(() => {
    const started: string[] = [];
    for (const v of videos) {
      const before = seen.current.get(v.id);
      if (before && before !== v.status && (v.status === "done" || v.status === "failed")) started.push(v.id);
      seen.current.set(v.id, v.status);
    }
    if (!started.length) return;
    const now = Date.now();
    setExiting(e => ({ ...e, ...Object.fromEntries(started.map(id => [id, now])) }));
    // Not cleared when `videos` changes again (the next video starts right away), only on unmount.
    timers.current.push(window.setTimeout(() => setExiting(e => {
      const next = { ...e };
      for (const id of started) delete next[id];
      return next;
    }), EXIT_MS));
  }, [videos]);
  useEffect(() => () => timers.current.forEach(t => window.clearTimeout(t)), []);

  const inDisc = videos.filter(v => v.status === "queued" || v.status === "running" || exiting[v.id]);
  const landed = videos.filter(v => (v.status === "done" || v.status === "failed") && !exiting[v.id]);
  const running = videos.find(v => v.status === "running");
  const status = stageStates(stages, !!running);

  const geometry = useMemo(() => {
    if (W < 220 || H < 180) return null;
    const binW = clamp(W * 0.2, 160, 244);
    const binX = W - binW - 12;
    const R = Math.min(H / 2 - 10, (W - binW) * 0.4);
    const cx = 10, cy = H / 2;
    const size = clamp(Math.round(R / 3.6), 44, 78);
    const slots = packSlots(cx, cy, R, size, 6);
    const left = cx + R + 26, right = binX - 26;
    const midW = clamp(right - left, 120, 300);
    const midX = left + Math.max(0, (right - left - midW) / 2);
    const spacing = clamp(H * 0.19, 62, 104);
    const stageY = [cy - spacing, cy, cy + spacing];
    const binGap = 10, margin = 12;
    const binH = (H - 2 * margin - 2 * binGap) / 3;
    const bins = Object.fromEntries(VERDICTS.map((v, i) => [v.id, { x: binX, y: margin + i * (binH + binGap), w: binW, h: binH }])) as Record<Verdict, { x: number; y: number; w: number; h: number }>;
    const edgeX = (y: number) => cx + Math.sqrt(Math.max(0, R * R - (y - cy) * (y - cy)));
    return { binW, binX, R, cx, cy, size, slots, midX, midW, stageY, bins, edgeX };
  }, [W, H]);

  // Which slot each disc video occupies; the last slot turns into "+N" when the queue overflows.
  const placed = useMemo(() => {
    if (!geometry) return [];
    const capacity = geometry.slots.length;
    const overflow = inDisc.length > capacity;
    const shown = overflow ? inDisc.slice(0, Math.max(0, capacity - 1)) : inDisc;
    return shown.map((video, i) => ({ video, slot: geometry.slots[i] }));
  }, [geometry, inDisc]);
  const hidden = geometry ? Math.max(0, inDisc.length - placed.length) : 0;

  // Lines that carry each finished video from its tile to its bin: one per window and provider.
  const streams = useMemo(() => {
    if (!geometry) return [];
    return placed.filter(p => exiting[p.video.id]).flatMap(({ video, slot }) => {
      const target = geometry.bins[video.verdict ?? "review"];
      const rows = Object.values(video.report?.providers ?? {}).flatMap(r => r.segments);
      const picks = rows.length > 22 ? rows.filter((_, i) => i % Math.ceil(rows.length / 22) === 0) : rows;
      const lines = (picks.length ? picks : [null]).map((row, i, all) => {
        const tone = !row ? "failed" : isFailed(row) ? "failed" : verdictOf(row);
        const fx = slot.x + geometry.size * (0.2 + 0.6 * ((i * 37) % 11) / 10);
        const fy = slot.y + geometry.size * (0.15 + 0.7 * (i + 0.5) / all.length);
        const x2 = target.x - 1;
        const y2 = target.y + target.h * (0.3 + 0.4 * (i + 0.5) / all.length);
        const dx = x2 - fx;
        return { key: `${video.id}-${i}`, tone, delay: i * 35,
          d: `M${fx.toFixed(1)},${fy.toFixed(1)} C${(fx + dx * 0.45).toFixed(1)},${fy.toFixed(1)} ${(x2 - dx * 0.38).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}` };
      });
      return lines;
    });
  }, [geometry, placed, exiting]);

  const progress = stageProgress(stages);
  const activeStage = status.provider ? 2 : stages.align.state === "run" ? 1 : stages.prepare.state === "run" ? 0 : -1;
  const runningPlace = placed.find(p => p.video.status === "running");

  return <div className="flow" ref={box}>
    {geometry && <svg width={W} height={H} aria-hidden="true">
      <path className="disc-halo" d={`M${geometry.cx},${geometry.cy - geometry.R - 14} A${geometry.R + 14},${geometry.R + 14} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R + 14}`} />
      <path className="disc-edge" d={`M${geometry.cx},${geometry.cy - geometry.R} A${geometry.R},${geometry.R} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R}`} />
      {geometry.slots.map((s, i) => <rect key={i} className="slot" x={s.x} y={s.y} width={geometry.size} height={geometry.size} rx={2} />)}

      {/* Connectors from the disc into the three stages; frame split and ASR run in parallel */}
      {(["frames", "asr", "classify"] as const).map((key, i) => {
        const y = geometry.stageY[i];
        return <line key={key} className={`connector s-${status[key]}`} x1={geometry.edgeX(y) + 2} y1={y} x2={geometry.midX - 12} y2={y} />;
      })}
      <path className={`parallel s-${status.frames === "run" || status.asr === "run" ? "run" : status.frames}`}
        d={`M${geometry.midX - 6},${geometry.stageY[0]} h-6 V${geometry.stageY[1]} h6`} />
      {/* Connectors from the stages into the bins */}
      {VERDICTS.map(v => {
        const b = geometry.bins[v.id];
        const x1 = geometry.midX + geometry.midW + 10, y1 = geometry.stageY[2];
        return <path key={v.id} className={`outlet v-${v.id}`} d={`M${x1},${y1} C${x1 + 40},${y1} ${b.x - 40},${b.y + b.h / 2} ${b.x - 2},${b.y + b.h / 2}`} />;
      })}

      {/* The running video is wired to whichever stage is active */}
      {runningPlace && activeStage >= 0 && <path className="live-wire"
        d={`M${runningPlace.slot.x + geometry.size},${runningPlace.slot.y + geometry.size / 2} C${geometry.midX - 60},${runningPlace.slot.y + geometry.size / 2} ${geometry.midX - 60},${geometry.stageY[activeStage]} ${geometry.midX - 12},${geometry.stageY[activeStage]}`} />}

      {streams.map(s => <g key={s.key}>
        <path d={s.d} className={`stream-trail v-${s.tone}`} pathLength={1} style={{ animationDelay: `${s.delay}ms` }} />
        <path d={s.d} className={`stream v-${s.tone}`} pathLength={1} style={{ animationDelay: `${s.delay}ms` }} />
      </g>)}
    </svg>}

    {geometry && <>
      {placed.length === 0 && <div className="disc-note" style={{ left: geometry.cx + geometry.R * 0.1, top: geometry.cy - 26, width: geometry.R * 0.82 }}>
        <b>NO INPUT</b><span>添加视频或文件夹后开始审核</span>
      </div>}

      {placed.map(({ video, slot }) => {
        const leaving = !!exiting[video.id];
        const cls = `tile ${leaving ? `exiting v-${video.status === "failed" ? "failed" : video.verdict}` : video.status}${selected === video.id ? " selected" : ""}`;
        return <button key={video.id} type="button" className={cls} style={{ left: slot.x, top: slot.y, width: geometry.size, height: geometry.size }}
          title={`${video.name}${video.status === "queued" ? " · 排队中" : video.status === "running" ? " · 审核中" : ""}`}
          onClick={() => onSelect(selected === video.id ? null : video.id)}>
          {video.thumb ? <img src={video.thumb} alt="" draggable={false} /> : <span className="tile-ph">{video.name.slice(0, 2)}</span>}
          {geometry.size >= 54 && <span className="tile-name">{video.name}</span>}
          {video.status === "running" && !leaving && <>
            <span className="tile-scan" />
            <span className="tile-state">{runningLabel(stages)}</span>
            <span className="tile-progress"><i style={{ width: `${progress * 100}%` }} /></span>
          </>}
          {leaving && <span className="tile-verdict">{video.status === "failed" ? "失败" : VERDICT_ZH[video.verdict ?? "review"]}</span>}
        </button>;
      })}
      {hidden > 0 && (() => {
        const slot = geometry.slots[geometry.slots.length - 1];
        return <div className="tile more" style={{ left: slot.x, top: slot.y, width: geometry.size, height: geometry.size }}>+{hidden + 1}<small>排队</small></div>;
      })()}

      {/* Stage labels, centred between the disc and the bins */}
      {[
        { key: "frames" as const, no: "01", zh: "画面切分", en: "FRAME SPLIT", sub: `定时 ${meta.interval}s ＋ 场景变化补帧`, extra: "" },
        { key: "asr" as const, no: "02", zh: "语音识别", en: "ASR", sub: meta.cloud ? `${meta.asr} · 30s 音频块对齐` : `${meta.asr} · 语音驱动窗口`, extra: status.aligning ? "对齐中" : "" },
        { key: "classify" as const, no: "03", zh: "分类判断", en: "CLASSIFY", sub: `逐段 · ≤${meta.segmentSeconds}s 窗口 · 取最严归类`,
          extra: status.provider ? `${providerLabel(status.provider.id)} ${(status.provider.done ?? 0) + 1}/${status.provider.total}` : "" },
      ].map((stage, i) => <div key={stage.key} className={`stage s-${status[stage.key]}${geometry.midW < 230 ? " compact" : ""}`}
        style={{ left: geometry.midX, top: geometry.stageY[i] - 25, width: geometry.midW }}>
        <span className="stage-no">{stage.no}</span>
        <div className="stage-body">
          <div className="stage-title"><b>{stage.zh}</b><em>{stage.en}</em>{i < 2 && <i className="stage-par">并行</i>}</div>
          <div className="stage-sub">{stage.sub}</div>
        </div>
        <span className="stage-state">{stage.extra || STATE_TEXT[status[stage.key]]}</span>
      </div>)}

      {/* Verdict bins hold finished videos; click a bin to list them, a cover to open that video */}
      {VERDICTS.map(v => {
        const b = geometry.bins[v.id];
        const items = landed.filter(x => x.verdict === v.id);
        const failed = items.filter(x => x.status === "failed").length;
        const thumb = clamp(Math.floor((b.w - 24 - 4 * 5) / 6), 18, 30);
        const fit = Math.max(0, Math.floor((b.h - 74) / (thumb + 4))) * 6;
        const shown = items.length > fit ? items.slice(-(Math.max(0, fit - 1))) : items;
        return <div key={v.id} className={`bin v-${v.id}${bin === v.id ? " on" : ""}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
          <button type="button" className="bin-hit" aria-pressed={bin === v.id} onClick={() => onBin(bin === v.id ? null : v.id)}
            aria-label={`${v.zh}：${items.length} 个视频，点击查看列表`} />
          <div className="bin-head"><span className="bin-en">{v.en}</span><span className="bin-count">×{items.length}</span></div>
          <div className="bin-zh">{v.zh}{v.id === "review" && <small>人工复核</small>}{failed > 0 && <small className="bin-failed">含处理失败 {failed}</small>}</div>
          <div className="bin-thumbs">
            {items.length > shown.length && <span className="bin-more" style={{ width: thumb, height: thumb }}>+{items.length - shown.length}</span>}
            {shown.map(x => <button key={x.id} type="button" className={`bin-thumb${selected === x.id ? " selected" : ""}${x.status === "failed" ? " failed" : ""}`}
              style={{ width: thumb, height: thumb }} title={x.name} onClick={() => onSelect(x.id)}>
              {x.thumb ? <img src={x.thumb} alt={x.name} draggable={false} /> : <span>{x.name.slice(0, 1)}</span>}
            </button>)}
          </div>
        </div>;
      })}

      <div className="flow-legend" style={{ left: geometry.midX, bottom: 10, width: geometry.midW }}>
        <span>方块 = 视频封面 · 审完化为流线进入判定</span>
        <span>线色 = 片段结论 · <i className="lg-dot v-failed" />失败归入待定</span>
      </div>
    </>}
  </div>;
}
