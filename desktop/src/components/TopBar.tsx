import { useEffect, useState } from "react";
import { agreement, baseName, fmtClock, fmtDuration, providerLabel, providersOf, tally, type ProviderFilter } from "../lib/report";
import type { EngineState, RunInfo } from "../useModeration";
import type { ModerationReport } from "../types";

interface Props {
  preview: boolean; engine: EngineState; busy: boolean;
  report: ModerationReport | null; visible: string[]; segmentsKnown?: number;
  filter: ProviderFilter; onFilter: (filter: ProviderFilter) => void;
  run: RunInfo | null; video: string;
}

const ENGINE_TEXT: Record<EngineState, string> = { connecting: "连接中", ready: "就绪", running: "审核中", error: "异常" };

function useNow(active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export default function TopBar({ preview, engine, busy, report, visible, segmentsKnown, filter, onFilter, run, video }: Props) {
  const now = useNow();
  const counts = tally(report, visible);
  const sum = (key: "allow" | "block" | "review" | "failed") => report ? visible.reduce((a, p) => a + (counts[p]?.[key] ?? 0), 0) : null;
  const segments = report ? Math.max(0, ...Object.values(report.providers).map(p => p.segments.length)) : segmentsKnown;
  const agree = agreement(report);
  const elapsed = run ? (run.finishedAt ?? now) - run.startedAt : null;
  const available = providersOf(report);
  const kpis: { label: string; zh: string; value: string; tone?: string; wide?: boolean }[] = [
    { label: "VIDEO", zh: "视频", value: video ? baseName(video) : "—", wide: true },
    { label: "SEG", zh: "片段", value: segments != null ? String(segments) : "—" },
    { label: "PASS", zh: "通过", value: fmt(sum("allow")), tone: "allow" },
    { label: "BLOCK", zh: "拦截", value: fmt(sum("block")), tone: sum("block") ? "block" : undefined },
    { label: "HOLD", zh: "待定", value: fmt(sum("review")), tone: sum("review") ? "review" : undefined },
    { label: "FAIL", zh: "失败", value: fmt(sum("failed")), tone: sum("failed") ? "failed" : undefined },
    { label: "AGREE", zh: "一致", value: agree == null ? "—" : `${Math.round(agree * 100)}%` },
    { label: "TIME", zh: "用时", value: elapsed == null ? "—" : fmtDuration(elapsed) },
  ];
  return <header className="topbar">
    <div className="brand">
      <div className="brand-title"><i className="brand-mark" />SVM <span>/</span> MODERATION LAB</div>
      <div className="brand-sub">短视频内容审核 · JEV × 多模态对照
        <span className="tag warn">阈值未校准</span>{preview && <span className="tag demo">DEMO 浏览器预览</span>}</div>
    </div>
    <dl className="kpis" aria-label="判定次数统计（按当前显示的模型组）">
      {kpis.map(k => <div key={k.label} className={`kpi${k.wide ? " wide" : ""}`}>
        <dt><b>{k.zh}</b> <span className="en">{k.label}</span></dt><dd className={k.tone ? `t-${k.tone}` : undefined} title={k.value}>{k.value}</dd>
      </div>)}
    </dl>
    <div className="top-actions">
      <div className="switch" role="group" aria-label="显示模型组">
        {(["all", ...["jev", "openai"]] as const).map(id => {
          const enabled = id === "all" || available.length === 0 || available.includes(id);
          return <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "on" : undefined}
            disabled={!enabled || (id !== "all" && available.length < 2)} onClick={() => onFilter(id)}>{id === "all" ? "全部" : providerLabel(id)}</button>;
        })}
      </div>
      <div className={`engine e-${engine}${busy ? " busy" : ""}`}>
        <i />引擎 {ENGINE_TEXT[engine]} · {fmtClock(now)}
      </div>
    </div>
  </header>;
}

function fmt(value: number | null) { return value == null ? "—" : String(value); }
