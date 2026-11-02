import { useEffect, useState } from "react";
import { finalVerdict, fmtClock, fmtDuration } from "../lib/report";
import type { BatchInfo, EngineState } from "../useModeration";
import type { VideoItem } from "../types";

interface Props {
  preview: boolean; engine: EngineState; busy: boolean;
  videos: VideoItem[]; batch: BatchInfo | null; queueActive: boolean; limit: number;
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

export default function TopBar({ preview, engine, busy, videos, batch, queueActive, limit }: Props) {
  const now = useNow();
  // Counts cover this batch; a reviewer's final decision replaces the model verdict.
  const count = (test: (v: VideoItem) => boolean) => videos.filter(v => !v.history && test(v)).length;
  const running = videos.filter(v => v.status === "running");
  const elapsed = batch ? (batch.finishedAt && !queueActive ? batch.finishedAt : now) - batch.startedAt : null;
  const tone = (n: number, t: string) => (n ? t : undefined);
  const block = count(v => finalVerdict(v) === "block"), review = count(v => finalVerdict(v) === "review"), failed = count(v => v.status === "failed");
  const kpis: { label: string; zh: string; value: string; tone?: string; wide?: boolean; title?: string }[] = [
    { label: "NOW", zh: "审核中", value: `${running.length}/${limit}`, title: running.map(v => v.name).join("\n") },
    { label: "QUEUE", zh: "排队", value: String(count(v => v.status === "queued")) },
    { label: "PASS", zh: "通过", value: String(count(v => finalVerdict(v) === "allow")), tone: "allow" },
    { label: "BLOCK", zh: "拦截", value: String(block), tone: tone(block, "block") },
    { label: "HOLD", zh: "待定", value: String(review), tone: tone(review, "review") },
    { label: "FAIL", zh: "失败", value: String(failed), tone: tone(failed, "failed") },
    { label: "TIME", zh: "用时", value: elapsed == null ? "—" : fmtDuration(elapsed) },
  ];
  return <header className="topbar">
    <div className="brand">
      <div className="brand-title"><i className="brand-mark" />SVM <span>/</span> MODERATION LAB</div>
      <div className="brand-sub"><span className="tag warn" title="阈值为实验配置，尚未用验证集校准">阈值未校准</span>{preview && <span className="tag demo">DEMO</span>}</div>
    </div>
    <dl className="kpis" aria-label="视频统计">
      {kpis.map(k => <div key={k.label} className={`kpi${k.wide ? " wide" : ""}`}>
        <dt><b>{k.zh}</b> <span className="en">{k.label}</span></dt><dd className={k.tone ? `t-${k.tone}` : undefined} title={k.title || k.value}>{k.value}</dd>
      </div>)}
    </dl>
    <div className="top-actions">
      <div className={`engine e-${engine}${busy ? " busy" : ""}`}>
        <i />引擎 {ENGINE_TEXT[engine]} · {fmtClock(now)}
      </div>
    </div>
  </header>;
}

