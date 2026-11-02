import { useMemo, useState } from "react";
import { useSize } from "../lib/useSize";
import {
  VERDICTS, fmtTime, isFailed, pad2, peakOf, providerLabel, segmentsOf, tally, verdictOf,
  type SegmentView, type Verdict,
} from "../lib/report";
import type { ModerationReport, Stage, StageId, StageState } from "../types";

interface Props {
  report: ModerationReport | null;
  providers: string[];
  stages: Record<StageId, Stage>;
  busy: boolean;
  selected: number | null;
  onSelect: (id: number | null) => void;
  meta: { interval: number; segmentSeconds: number; asr: string; cloud: boolean };
}

interface Row { y: number; h: number; x0: number; len: number; time: number }
interface Piece { index: number; x: number; y: number; w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Lays the video timeline out like wrapped text inside a half-disc: rows run top to bottom,
 * each window is a brick whose length is proportional to its duration (long windows wrap).
 */
function layoutDisc(cx: number, cy: number, R: number, weights: number[]) {
  const rowsCount = clamp(Math.round(Math.sqrt(weights.length) * 2.3), 9, 24);
  const inset = 8;
  const pitch = (2 * (R - inset)) / rowsCount;
  const gap = clamp(pitch * 0.16, 2, 4);
  const h = pitch - gap;
  const rows: Row[] = [];
  for (let r = 0; r < rowsCount; r++) {
    const y = cy - R + inset + r * pitch + gap / 2;
    const dy = Math.max(Math.abs(y - cy), Math.abs(y + h - cy));
    const half = dy < R ? Math.sqrt(R * R - dy * dy) : 0;
    const x0 = cx + 6;
    const len = cx + half - inset - x0;
    if (len > 10) rows.push({ y, h, x0, len, time: 0 });
  }
  const total = rows.reduce((a, r) => a + r.len, 0);
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const scale = total / sum;
  let cumulative = 0;
  for (const row of rows) { row.time = cumulative / scale; cumulative += row.len; }
  const pieces: Piece[] = [];
  let ri = 0, pos = 0;
  weights.forEach((weight, index) => {
    let remaining = weight * scale;
    while (remaining > 0.01 && ri < rows.length) {
      const row = rows[ri];
      const take = Math.min(row.len - pos, remaining);
      pieces.push({ index, x: row.x0 + pos, y: row.y, w: take, h: row.h });
      pos += take; remaining -= take;
      if (row.len - pos < 0.01) { ri += 1; pos = 0; }
    }
  });
  return { rows, pieces, rowH: h };
}

function stageOf(stages: Record<StageId, Stage>, report: ModerationReport | null) {
  const { prepare, align, jev, openai } = stages;
  const frames: StageState = prepare.state === "run" ? "run" : prepare.state;
  const asr: StageState = prepare.state === "run" || align.state === "run" ? "run"
    : prepare.state === "fail" || align.state === "fail" ? "fail" : align.state === "pass" ? "pass" : "wait";
  let classify: StageState = "wait";
  if (jev.state === "fail" || openai.state === "fail") classify = "fail";
  else if (jev.state === "run" || openai.state === "run") classify = "run";
  else if (report) classify = Object.values(report.providers).every(p => p.complete) ? "pass" : "warn";
  const runningProvider = jev.state === "run" ? jev : openai.state === "run" ? openai : null;
  return { frames, asr, classify, runningProvider, aligning: align.state === "run" };
}

const STATE_TEXT: Record<StageState, string> = { wait: "WAIT", run: "RUN", pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export default function FlowMap({ report, providers, stages, busy, selected, onSelect, meta }: Props) {
  const [box, { width: W, height: H }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const segments = useMemo(() => segmentsOf(report, providers), [report, providers]);
  const counts = useMemo(() => tally(report, providers), [report, providers]);
  const status = stageOf(stages, report);

  // What goes into the disc: real windows, N placeholders once the count is known, or a ghost grid.
  const known = stages.jev.total ?? stages.openai.total;
  const mode: "report" | "running" | "idle" = segments.length ? "report" : known ? "running" : "idle";
  const weights = useMemo(() => mode === "report" ? segments.map(s => Math.max(0.05, s.end - s.start))
    : Array.from({ length: mode === "running" ? known! : 42 }, () => 1), [mode, segments, known]);

  const geometry = useMemo(() => {
    if (W < 200 || H < 160) return null;
    const binW = clamp(W * 0.2, 150, 232);
    const binX = W - binW - 12;
    const R = Math.min(H / 2 - 10, (W - binW) * 0.42);
    const cx = 10, cy = H / 2;
    const disc = layoutDisc(cx, cy, R, weights);
    const midX = cx + R + 30;
    const midW = Math.max(120, Math.min(300, binX - midX - 36));
    const binGap = 10, margin = 12;
    const binH = (H - 2 * margin - 2 * binGap) / 3;
    const bins = Object.fromEntries(VERDICTS.map((v, i) => [v.id, { x: binX, y: margin + i * (binH + binGap), w: binW, h: binH }])) as Record<Verdict, { x: number; y: number; w: number; h: number }>;
    const stageY = [0.22, 0.44, 0.66].map(f => H * f);
    const edgeX = (y: number) => cx + Math.sqrt(Math.max(0, R * R - (y - cy) * (y - cy)));
    return { binW, binX, R, cx, cy, disc, midX, midW, bins, stageY, edgeX };
  }, [W, H, weights]);

  // Long windows wrap across rows; the widest piece carries the label and the curve anchor.
  const widest = useMemo(() => {
    const map = new Map<number, Piece>();
    for (const piece of geometry?.disc.pieces ?? []) {
      if ((map.get(piece.index)?.w ?? -1) < piece.w) map.set(piece.index, piece);
    }
    return map;
  }, [geometry]);

  const curves = useMemo(() => {
    if (!geometry || mode !== "report") return [];
    const anchor = new Map([...widest].map(([i, p]) => [i, { x: p.x + p.w / 2, y: p.y + p.h / 2 }]));
    const entries: { key: string; segment: SegmentView; index: number; provider: string; verdict: Verdict; failed: boolean; peak: number; x1: number; y1: number }[] = [];
    segments.forEach((segment, index) => {
      const start = anchor.get(index);
      if (!start) return;
      for (const provider of providers) {
        const row = segment.rows[provider];
        if (!row) continue;
        entries.push({ key: `${provider}-${segment.id}`, segment, index, provider, verdict: verdictOf(row),
                       failed: isFailed(row), peak: peakOf(row), x1: start.x, y1: start.y });
      }
    });
    const out: (typeof entries[number] & { d: string; x2: number; y2: number })[] = [];
    for (const v of VERDICTS) {
      const bin = geometry.bins[v.id];
      const list = entries.filter(e => e.verdict === v.id).sort((a, b) => a.y1 - b.y1 || a.provider.localeCompare(b.provider));
      const top = bin.y + 22, span = bin.h - 44;
      list.forEach((e, k) => {
        const x2 = bin.x - 1, y2 = top + ((k + 0.5) / list.length) * span;
        const dx = x2 - e.x1;
        const d = `M${e.x1.toFixed(1)},${e.y1.toFixed(1)} C${(e.x1 + dx * 0.45).toFixed(1)},${e.y1.toFixed(1)} ${(x2 - dx * 0.38).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
        out.push({ ...e, d, x2, y2 });
      });
    }
    return out;
  }, [geometry, widest, mode, segments, providers]);

  const focus = hover ?? selected;
  const dashed = providers.length > 1;
  const running = status.runningProvider;
  const doneUpTo = running?.done ?? 0;
  const lastProvider = stages.openai.state === "run" ? "openai" : "jev";

  function renderCurves(focusedOnly: boolean) {
    return curves.filter(c => (focus === c.segment.id) === focusedOnly).map(c => {
      const active = focus === c.segment.id;
      const dim = focus != null && !active;
      return <g key={c.key} className="curve-hit" onMouseEnter={() => setHover(c.segment.id)} onMouseLeave={() => setHover(null)}
        onClick={() => onSelect(selected === c.segment.id ? null : c.segment.id)}>
        <path d={c.d} className="curve-pick" />
        <path d={c.d} className={`curve v-${c.failed ? "failed" : c.verdict}`}
          strokeDasharray={dashed && c.provider !== providers[0] ? "5 4" : undefined}
          style={{ opacity: dim ? 0.07 : active ? 1 : 0.3 + c.peak * 0.5, strokeWidth: active ? 2.4 : 0.9 + c.peak * 1.3 }}>
          <title>{`${providerLabel(c.provider)} · 片段 ${pad2(c.segment.id)} → ${c.failed ? "失败 · 待定" : VERDICTS.find(v => v.id === c.verdict)!.zh}`}</title>
        </path>
        <circle cx={c.x1} cy={c.y1} r={active ? 3 : 1.8} className={`dot v-${c.failed ? "failed" : c.verdict}`} style={{ opacity: dim ? 0.1 : 1 }} />
        <circle cx={c.x2} cy={c.y2} r={1.6} className={`dot v-${c.failed ? "failed" : c.verdict}`} style={{ opacity: dim ? 0.1 : 0.9 }} />
      </g>;
    });
  }

  return <div className="flow" ref={box}>
    {geometry && <svg width={W} height={H} role="img" aria-label="片段流向：左侧为按时长排布的审核窗口，右侧为通过、拦截、待定三类判定">
      <defs>
        <clipPath id="disc-clip"><path d={`M${geometry.cx},${geometry.cy - geometry.R} A${geometry.R},${geometry.R} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R} Z`} /></clipPath>
        <linearGradient id="scan" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
          <stop offset="0.85" stopColor="var(--accent)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.55" />
        </linearGradient>
        <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" className="hatch-line" />
        </pattern>
      </defs>

      {/* Disc outline and halo rings */}
      <path className="disc-halo" d={`M${geometry.cx},${geometry.cy - geometry.R - 14} A${geometry.R + 14},${geometry.R + 14} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R + 14}`} />
      <path className="disc-edge" d={`M${geometry.cx},${geometry.cy - geometry.R} A${geometry.R},${geometry.R} 0 0 1 ${geometry.cx},${geometry.cy + geometry.R}`} />

      {/* Connectors from the disc into the three stages; frame split and ASR are parallel */}
      {(["frames", "asr", "classify"] as const).map((key, i) => {
        const y = geometry.stageY[i];
        return <line key={key} className={`connector s-${status[key]}`} x1={geometry.edgeX(y) + 2} y1={y} x2={geometry.midX - 12} y2={y} />;
      })}
      <path className={`parallel s-${status.frames === "run" || status.asr === "run" ? "run" : status.frames}`}
        d={`M${geometry.midX - 6},${geometry.stageY[0]} h-6 V${geometry.stageY[1]} h6`} />

      {/* Judgement curves (one per provider × window) run under the bricks; the focused one is redrawn on top. */}
      {renderCurves(false)}

      {/* Bricks */}
      <g clipPath="url(#disc-clip)">
        {geometry.disc.pieces.map((p, k) => {
          const segment = mode === "report" ? segments[p.index] : null;
          let cls = "brick ghost";
          let opacity = 1;
          if (segment) {
            cls = `brick v-${segment.failed && segment.verdict === "review" ? "failed" : segment.verdict}`;
            opacity = segment.verdict === "allow" ? 0.5 + segment.peak : 0.55 + segment.peak * 0.45;
            if (focus != null && focus !== segment.id) opacity *= 0.35;
          } else if (mode === "running") {
            const jevDone = stages.jev.state === "pass" || stages.jev.state === "warn";
            if (running && p.index < doneUpTo) cls = `brick lit p-${lastProvider}`;
            else if (running && p.index === doneUpTo) cls = `brick current p-${lastProvider}`;
            else if (jevDone && lastProvider === "openai") cls = "brick lit p-jev";
            else cls = "brick queued";
          }
          const label = segment && p.w >= 22 && p.h >= 13 && widest.get(p.index) === p;
          return <g key={k} className={segment ? "brick-hit" : undefined}
            onMouseEnter={segment ? () => setHover(segment.id) : undefined}
            onMouseLeave={segment ? () => setHover(null) : undefined}
            onClick={segment ? () => onSelect(selected === segment.id ? null : segment.id) : undefined}>
            <rect className={cls + (segment && selected === segment.id ? " selected" : "")}
              x={p.x + 1} y={p.y} width={Math.max(1, p.w - 2)} height={p.h} rx={1.5} style={{ opacity }}>
              {segment && <title>{`片段 ${pad2(segment.id)} · ${fmtTime(segment.start)}–${fmtTime(segment.end)} · ${VERDICTS.find(v => v.id === segment.verdict)!.zh}${segment.failed ? "（含失败）" : ""}`}</title>}
            </rect>
            {label && <text className="brick-label" x={p.x + 5} y={p.y + p.h / 2 + 3.5}>{pad2(segment!.id)}</text>}
          </g>;
        })}
        {busy && mode === "idle" && <g className="scan-group">
          <rect x={geometry.cx} y={-geometry.R * 0.5} width={geometry.R} height={geometry.R * 0.5} fill="url(#scan)">
            <animateTransform attributeName="transform" type="translate" from={`0 ${geometry.cy - geometry.R}`} to={`0 ${geometry.cy + geometry.R * 1.5}`} dur="2.6s" repeatCount="indefinite" />
          </rect>
        </g>}
      </g>

      {/* Row start times along the arc: the disc is the video read top to bottom */}
      {mode === "report" && geometry.disc.rows.map((row, i) => (geometry.disc.rowH >= 15 || i % 2 === 0) &&
        <text key={i} className="arc-time" x={geometry.edgeX(row.y + row.h / 2) + 8} y={row.y + row.h / 2 + 3}>{fmtTime(row.time, false)}</text>)}

      {renderCurves(true)}
    </svg>}

    {geometry && <>
      {mode === "idle" && <div className="disc-note" style={{ left: geometry.cx + geometry.R * 0.12, top: geometry.cy - 26, width: geometry.R * 0.8 }}>
        <b>{busy ? "SAMPLING" : "NO INPUT"}</b><span>{busy ? "抽帧与转写进行中…" : "选择视频并开始审核"}</span>
      </div>}

      {/* Stage labels: frame split ∥ speech recognition → classification */}
      {[
        { key: "frames" as const, no: "01", zh: "画面切分", en: "FRAME SPLIT", sub: `定时 ${meta.interval}s ＋ 场景变化补帧`, extra: "" },
        { key: "asr" as const, no: "02", zh: "语音识别", en: "ASR", sub: meta.cloud ? `${meta.asr} · 30s 音频块对齐` : `${meta.asr} · 语音驱动窗口`, extra: status.aligning ? "对齐中" : "" },
        { key: "classify" as const, no: "03", zh: "分类判断", en: "CLASSIFY", sub: `逐段 · ≤${meta.segmentSeconds}s 窗口 · 同一输入`,
          extra: status.runningProvider ? `${providerLabel(status.runningProvider.id)} ${(status.runningProvider.done ?? 0) + 1}/${status.runningProvider.total}` : "" },
      ].map((stage, i) => <div key={stage.key} className={`stage s-${status[stage.key]}${geometry.midW < 230 ? " compact" : ""}`}
        style={{ left: geometry.midX, top: geometry.stageY[i] - 25, width: geometry.midW }}>
        <span className="stage-no">{stage.no}</span>
        <div className="stage-body">
          <div className="stage-title"><b>{stage.zh}</b><em>{stage.en}</em>{i < 2 && <i className="stage-par">并行</i>}</div>
          <div className="stage-sub">{stage.sub}</div>
        </div>
        <span className="stage-state">{stage.extra || STATE_TEXT[status[stage.key]]}</span>
      </div>)}

      {/* Verdict bins */}
      {VERDICTS.map(v => {
        const bin = geometry.bins[v.id];
        const total = providers.reduce((a, p) => a + (counts[p]?.[v.id] ?? 0), 0);
        const failed = v.id === "review" ? providers.reduce((a, p) => a + (counts[p]?.failed ?? 0), 0) : 0;
        const all = providers.reduce((a, p) => a + (report?.providers[p]?.segments.length ?? 0), 0);
        return <div key={v.id} className={`bin v-${v.id}`} style={{ left: bin.x, top: bin.y, width: bin.w, height: bin.h }}>
          <div className="bin-head"><span className="bin-en">{v.en}</span><span className="bin-count">{mode === "report" ? `×${total}` : "—"}</span></div>
          <div className="bin-zh">{v.zh}{v.id === "review" && <small>人工复核</small>}</div>
          {mode === "report" && <>
            <div className="bin-rows">{providers.map(p => <span key={p}><em>{providerLabel(p)}</em>{counts[p]?.[v.id] ?? 0}</span>)}</div>
            {failed > 0 && <div className="bin-failed">含失败片段 {failed}</div>}
            <div className="bin-bar"><i style={{ width: `${all ? (total / all) * 100 : 0}%` }} /></div>
          </>}
        </div>;
      })}

      <div className="flow-legend" style={{ left: geometry.midX, bottom: 10, maxWidth: geometry.midW + 40 }}>
        {dashed && <><span className="lg-solid" />{providerLabel(providers[0])}<span className="lg-dash" />{providerLabel(providers[1])}</>}
        <span className="lg-dot v-failed" />失败 · 归入待定
        <span className="lg-note">线宽/亮度 = 峰值分数 · 砖块长度 = 窗口时长</span>
      </div>
    </>}
  </div>;
}
