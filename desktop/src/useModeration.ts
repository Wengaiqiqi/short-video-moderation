import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ModerationReport, ModerationRequest, Settings, WorkerEvent } from "./types";

export function useModeration() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在连接审核引擎…");
  const [report, setReport] = useState<ModerationReport | null>(null);
  useEffect(() => {
    let alive = true;
    let dispose: (() => void) | undefined;
    async function connect() {
      dispose = await listen<WorkerEvent>("worker-event", ({ payload }) => {
        if (!alive) return;
        if (payload.settings) { setSettings(payload.settings); setMessage("就绪"); }
        if (payload.message || payload.error) setMessage(payload.error || payload.message || "");
        if (["moderation.completed", "moderation.failed", "worker.error", "worker.exited"].includes(payload.type)) setBusy(false);
        if (payload.report) setReport(payload.report);
      });
      if (!alive) { dispose(); return; }
      await invoke("send_worker_command", { command: { action: "initialize" } });
    }
    void connect().catch(error => { if (alive) setMessage(`连接失败：${String(error)}。请使用 npm run dev 打开桌面端。`); });
    return () => { alive = false; dispose?.(); };
  }, []);
  async function start(payload: ModerationRequest) {
    setBusy(true); setReport(null); setMessage("正在准备审核…");
    try {
      await invoke("send_worker_command", { command: { action: "moderation_start", payload } });
    } catch (error) { setBusy(false); setMessage(String(error)); }
  }
  return { settings, setSettings, busy, message, report, start };
}
