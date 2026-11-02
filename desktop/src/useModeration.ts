import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEMO_SETTINGS, simulateRun } from "./demo";
import { baseName, providerLabel } from "./lib/report";
import type { LogEntry, ModerationReport, ModerationRequest, Settings, Stage, StageId, WorkerEvent } from "./types";

export type EngineState = "connecting" | "ready" | "running" | "error";
export const STAGE_ORDER: StageId[] = ["engine", "prepare", "align", "jev", "openai", "report"];
type Stages = Record<StageId, Stage>;

export interface RunInfo {
  startedAt: number; finishedAt?: number;
  provider: ModerationRequest["provider"]; modality: ModerationRequest["modality"];
  asrEngine: Settings["asr_engine"]; video: string;
}

function freshStages(provider?: ModerationRequest["provider"], engineReady = false): Stages {
  const stages = Object.fromEntries(STAGE_ORDER.map(id => [id, { id, state: "wait" }])) as Stages;
  if (engineReady) stages.engine.state = "pass";
  if (provider === "jev") stages.openai.state = "skip";
  if (provider === "openai") stages.jev.state = "skip";
  return stages;
}

const SEGMENT_PROGRESS = /^(\w+): 片段 (\d+)\/(\d+)/;
const LOG_LIMIT = 300;

export function useModeration() {
  const preview = !isTauri();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<EngineState>("connecting");
  const [message, setMessage] = useState("正在连接审核引擎…");
  const [report, setReport] = useState<ModerationReport | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stages, setStages] = useState<Stages>(() => freshStages());
  const [run, setRun] = useState<RunInfo | null>(null);
  const sequence = useRef(0);
  const cancelDemo = useRef<(() => void) | undefined>(undefined);

  const append = useCallback((level: LogEntry["level"], tag: string, text: string) => {
    const entry = { id: ++sequence.current, at: Date.now(), level, tag, text };
    setLog(previous => [...previous.slice(-(LOG_LIMIT - 1)), entry]);
  }, []);

  const handle = useCallback((payload: WorkerEvent) => {
    const text = payload.error || payload.message || "";
    if (text) setMessage(text);
    switch (payload.type) {
      case "worker.ready":
        if (payload.settings) setSettings(payload.settings);
        setEngine("ready"); setMessage("就绪");
        setStages(s => ({ ...s, engine: { id: "engine", state: "pass" } }));
        append("ok", "ENGINE", preview ? "浏览器预览：使用 DEMO 示例引擎" : "审核引擎就绪");
        break;
      case "moderation.progress": {
        const match = SEGMENT_PROGRESS.exec(payload.message ?? "");
        setStages(s => {
          const next = { ...s };
          if (match) {
            const [, provider, current, total] = match;
            const id = (provider === "jev" || provider === "openai") ? provider : null;
            next.prepare = { ...next.prepare, state: "pass" };
            next.align = { ...next.align, state: "pass" };
            // Providers run one after another: a new provider means the previous one finished.
            for (const other of ["jev", "openai"] as const) {
              if (other !== id && next[other].state === "run") next[other] = { ...next[other], state: "pass", done: next[other].total };
            }
            if (id) next[id] = { id, state: "run", done: Number(current) - 1, total: Number(total) };
          } else if (payload.message?.startsWith("并行处理")) {
            next.prepare = { id: "prepare", state: "run" };
          } else if (payload.message?.startsWith("按讲话时间")) {
            next.prepare = { id: "prepare", state: "pass" };
            next.align = { id: "align", state: "run" };
          }
          return next;
        });
        if (match) {
          const [, provider, current, total] = match;
          append("run", providerLabel(provider), `片段 ${current}/${total}`);
        } else append("run", "PIPELINE", payload.message ?? "");
        break;
      }
      case "moderation.completed": {
        const result = payload.report ?? null;
        setReport(result); setBusy(false); setEngine("ready");
        setRun(r => r && { ...r, finishedAt: Date.now() });
        setStages(s => {
          const next = { ...s };
          for (const id of STAGE_ORDER) if (next[id].state === "run" || next[id].state === "wait") next[id] = { ...next[id], state: "pass" };
          for (const [provider, data] of Object.entries(result?.providers ?? {})) {
            if (provider === "jev" || provider === "openai") {
              next[provider] = { id: provider, state: data.complete ? "pass" : "warn", done: data.segments.length, total: data.segments.length };
            }
          }
          return next;
        });
        const incomplete = Object.entries(result?.providers ?? {}).filter(([, data]) => !data.complete);
        if (incomplete.length) append("warn", "REVIEW", `${incomplete.map(([p]) => providerLabel(p)).join("、")} 存在失败片段，已归入待定，需人工复核`);
        append("ok", "REPORT", `审核完成 · ${result?.report_path ?? ""}`);
        break;
      }
      case "moderation.failed":
      case "worker.error":
      case "worker.exited":
        setBusy(false);
        if (payload.type === "worker.exited") setEngine("error"); else setEngine(e => (e === "running" ? "ready" : e));
        setRun(r => r && !r.finishedAt ? { ...r, finishedAt: Date.now() } : r);
        setStages(s => {
          const next = { ...s };
          for (const id of STAGE_ORDER) if (next[id].state === "run") next[id] = { ...next[id], state: "fail" };
          if (payload.type === "worker.exited") next.engine = { id: "engine", state: "fail" };
          return next;
        });
        append("error", payload.type === "moderation.failed" ? "FAILED" : "ENGINE", text || "未知错误");
        break;
      case "moderation.rejected":
        append("warn", "REJECT", text);
        break;
      default:
        if (text) append("info", payload.type.toUpperCase(), text);
    }
  }, [append, preview]);

  useEffect(() => {
    let alive = true;
    if (preview) {
      const timer = window.setTimeout(() => {
        if (alive) handle({ type: "worker.ready", settings: DEMO_SETTINGS });
      }, 250);
      return () => { alive = false; window.clearTimeout(timer); cancelDemo.current?.(); };
    }
    let dispose: (() => void) | undefined;
    async function connect() {
      dispose = await listen<WorkerEvent>("worker-event", ({ payload }) => { if (alive) handle(payload); });
      if (!alive) { dispose(); return; }
      await invoke("send_worker_command", { command: { action: "initialize" } });
    }
    void connect().catch(error => {
      if (!alive) return;
      setEngine("error");
      setMessage(`连接失败：${String(error)}。请使用 npm run dev 打开桌面端。`);
      append("error", "ENGINE", `连接失败：${String(error)}`);
    });
    return () => { alive = false; dispose?.(); };
  }, [append, handle, preview]);

  async function start(payload: ModerationRequest) {
    setBusy(true); setReport(null); setEngine("running"); setMessage("正在准备审核…");
    setStages(freshStages(payload.provider, true));
    setRun({ startedAt: Date.now(), provider: payload.provider, modality: payload.modality,
             asrEngine: payload.settings.asr_engine, video: payload.video_path });
    append("info", "SUBMIT", `提交任务 · ${baseName(payload.video_path)}`);
    if (preview) {
      cancelDemo.current?.();
      cancelDemo.current = simulateRun(payload, handle);
      return;
    }
    try {
      await invoke("send_worker_command", { command: { action: "moderation_start", payload } });
    } catch (error) {
      setBusy(false); setEngine("error"); setMessage(String(error));
      setStages(s => ({ ...s, engine: { id: "engine", state: "fail" } }));
      append("error", "ENGINE", String(error));
    }
  }

  return { preview, settings, setSettings, busy, engine, message, report, log, stages, run, start };
}
