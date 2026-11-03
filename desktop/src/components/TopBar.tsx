import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { finalVerdict, fmtDuration } from "../lib/report";
import type { BatchInfo } from "../useModeration";
import type { VideoItem } from "../types";

interface Props {
  preview: boolean;
  videos: VideoItem[]; batch: BatchInfo | null; queueActive: boolean; limit: number;
  theme: "dark" | "light"; onTheme: (theme: "dark" | "light") => void;
}

function useNow(active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Minimise / maximise / close: the window has no system title bar, the top bar takes its place. */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true, unlisten: (() => void) | undefined;
    const sync = () => { void win.isMaximized().then(m => { if (alive) setMaximized(m); }); };
    sync();
    void win.onResized(sync).then(u => { if (alive) unlisten = u; else u(); });
    return () => { alive = false; unlisten?.(); };
  }, []);
  const win = getCurrentWindow();
  return <div className="win-controls">
    <button type="button" className="win-btn" aria-label="最小化" title="最小化" onClick={() => void win.minimize()}>
      <svg viewBox="0 0 10 10"><path d="M1 5.5h8" /></svg></button>
    <button type="button" className="win-btn" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"}
      onClick={() => void win.toggleMaximize()}>
      {maximized ? <svg viewBox="0 0 10 10"><path d="M1.5 3.5h5v5h-5z M3.5 3.5v-2h5v5h-2" /></svg>
        : <svg viewBox="0 0 10 10"><path d="M1.5 1.5h7v7h-7z" /></svg>}</button>
    <button type="button" className="win-btn close" aria-label="关闭" title="关闭" onClick={() => void win.close()}>
      <svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg></button>
  </div>;
}

/** Drag the window by any empty part of the top bar; double-click maximises, as a title bar does. */
function dragWindow(e: MouseEvent) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
  const win = getCurrentWindow();
  void (e.detail === 2 ? win.toggleMaximize() : win.startDragging());
}

export default function TopBar({ preview, videos, batch, queueActive, limit, theme, onTheme }: Props) {
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
  return <header className="topbar" onMouseDown={preview ? undefined : dragWindow}>
    <div className="brand">
      <div className="brand-title"><i className="brand-mark" />短视频内容审核系统</div>
      {preview && <div className="brand-sub"><span className="tag demo">演示数据</span></div>}
    </div>
    <dl className="kpis" aria-label="视频统计">
      {kpis.map(k => <div key={k.label} className={`kpi${k.wide ? " wide" : ""}`}>
        <dt>{k.zh}</dt><dd className={k.tone ? `t-${k.tone}` : undefined} title={k.title || k.value}>{k.value}</dd>
      </div>)}
    </dl>
    <div className="top-actions">
      <button type="button" className="theme-toggle" onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
        aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} title={theme === "dark" ? "浅色主题" : "深色主题"}>
        {theme === "dark" ? "☀" : "☾"}</button>
      {!preview && <WindowControls />}
    </div>
  </header>;
}

