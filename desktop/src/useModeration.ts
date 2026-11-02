import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEMO_SETTINGS, demoThumbnail, demoVideos, simulateRun } from "./demo";
import { baseName, providerLabel, VERDICT_ZH, videoVerdict } from "./lib/report";
import type { LogEntry, ModerationRequest, Settings, Stage, StageId, VideoItem, WorkerEvent } from "./types";

export type EngineState = "connecting" | "ready" | "running" | "error";
export const STAGE_ORDER: StageId[] = ["engine", "prepare", "align", "jev", "openai", "report"];
type Stages = Record<StageId, Stage>;
/** Everything in a request except the video; fixed when the queue starts. */
export type RunConfig = Omit<ModerationRequest, "video_path">;
export interface BatchInfo { startedAt: number; finishedAt?: number; asrEngine: Settings["asr_engine"] }

function freshStages(provider?: ModerationRequest["provider"], engineReady = false): Stages {
  const stages = Object.fromEntries(STAGE_ORDER.map(id => [id, { id, state: "wait" }])) as Stages;
  if (engineReady) stages.engine.state = "pass";
  if (provider === "jev") stages.openai.state = "skip";
  if (provider === "openai") stages.jev.state = "skip";
  return stages;
}

const SEGMENT_PROGRESS = /^(\w+): 片段 (\d+)\/(\d+)/;
const LOG_LIMIT = 400;

export function useModeration() {
  const preview = !isTauri();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<EngineState>("connecting");
  const [message, setMessage] = useState("正在连接审核引擎…");
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [queueActive, setQueueActive] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stages, setStages] = useState<Stages>(() => freshStages());
  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const sequence = useRef(0);
  const current = useRef<VideoItem | null>(null);
  const config = useRef<RunConfig | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const cancelDemo = useRef<(() => void) | undefined>(undefined);
  settingsRef.current = settings;

  const append = useCallback((level: LogEntry["level"], tag: string, text: string) => {
    const entry = { id: ++sequence.current, at: Date.now(), level, tag, text };
    setLog(previous => [...previous.slice(-(LOG_LIMIT - 1)), entry]);
  }, []);

  const send = useCallback(async (command: unknown) => {
    await invoke("send_worker_command", { command });
  }, []);

  const videosRef = useRef<VideoItem[]>([]);
  videosRef.current = videos;

  const addPaths = useCallback((paths: string[]) => {
    const pending = new Set(videosRef.current.filter(v => v.status === "queued" || v.status === "running").map(v => v.path));
    const fresh: VideoItem[] = [];
    for (const path of paths) {
      const clean = path.trim();
      if (!clean || pending.has(clean)) continue;
      pending.add(clean);
      fresh.push({ id: `v${++sequence.current}`, path: clean, name: baseName(clean), status: "queued" });
    }
    if (!fresh.length) return;
    videosRef.current = [...videosRef.current, ...fresh];
    setVideos(list => [...list, ...fresh]);
    append("info", "QUEUE", `加入 ${fresh.length} 个视频`);
    for (const item of fresh) {
      if (preview) {
        window.setTimeout(() => setVideos(list => list.map(v => v.id === item.id ? { ...v, thumb: demoThumbnail(item.path) } : v)), 120);
      } else {
        void send({ action: "thumbnail", payload: { id: item.id, video_path: item.path, ffmpeg_path: settingsRef.current?.ffmpeg_path || null } })
          .catch(error => append("warn", "COVER", String(error)));
      }
    }
  }, [append, preview, send]);

  const finish = useCallback((patch: Partial<VideoItem>) => {
    const item = current.current;
    current.current = null;
    setBusy(false);
    if (!item) return;
    setVideos(list => list.map(v => v.id === item.id ? { ...v, ...patch, finishedAt: Date.now() } : v));
  }, []);

  const handle = useCallback((payload: WorkerEvent) => {
    const text = payload.error || payload.message || "";
    const name = current.current?.name ?? "";
    switch (payload.type) {
      case "worker.ready":
        if (payload.settings) setSettings(s => s ?? payload.settings!);
        setEngine("ready"); setMessage("就绪");
        setStages(s => ({ ...s, engine: { id: "engine", state: "pass" } }));
        append("ok", "ENGINE", preview ? "浏览器预览：使用 DEMO 示例引擎" : "审核引擎就绪");
        return;
      case "video.thumbnail":
        if (payload.data_url) setVideos(list => list.map(v => v.id === payload.id ? { ...v, thumb: payload.data_url } : v));
        return;
      case "videos.listed":
        if (payload.error) { append("error", "FOLDER", payload.error); return; }
        if (!payload.videos?.length) { append("warn", "FOLDER", `文件夹中没有 mp4/mkv/mov/webm 视频：${payload.directory ?? ""}`); return; }
        addPaths(payload.videos);
        return;
    }
    if (text) setMessage(text);
    switch (payload.type) {
      case "moderation.progress": {
        const match = SEGMENT_PROGRESS.exec(payload.message ?? "");
        setStages(s => {
          const next = { ...s };
          if (match) {
            const [, provider, done, total] = match;
            const id = (provider === "jev" || provider === "openai") ? provider : null;
            next.prepare = { ...next.prepare, state: "pass" };
            next.align = { ...next.align, state: "pass" };
            // Providers run one after another: a new provider means the previous one finished.
            for (const other of ["jev", "openai"] as const) {
              if (other !== id && next[other].state === "run") next[other] = { ...next[other], state: "pass", done: next[other].total };
            }
            if (id) next[id] = { id, state: "run", done: Number(done) - 1, total: Number(total) };
          } else if (payload.message?.startsWith("并行处理")) {
            next.prepare = { id: "prepare", state: "run" };
          } else if (payload.message?.startsWith("按讲话时间")) {
            next.prepare = { id: "prepare", state: "pass" };
            next.align = { id: "align", state: "run" };
          }
          return next;
        });
        if (match) {
          const [, provider, done, total] = match;
          if (done === "1" || done === total) append("run", providerLabel(provider), `${name} · 片段 ${done}/${total}`);
        } else append("run", "PIPELINE", `${name} · ${payload.message ?? ""}`);
        return;
      }
      case "moderation.completed": {
        const report = payload.report ?? undefined;
        const verdict = videoVerdict(report);
        setStages(s => {
          const next = { ...s };
          for (const id of STAGE_ORDER) if (next[id].state === "run" || next[id].state === "wait") next[id] = { ...next[id], state: "pass" };
          for (const [provider, data] of Object.entries(report?.providers ?? {})) {
            if (provider === "jev" || provider === "openai") {
              next[provider] = { id: provider, state: data.complete ? "pass" : "warn", done: data.segments.length, total: data.segments.length };
            }
          }
          return next;
        });
        const incomplete = Object.entries(report?.providers ?? {}).filter(([, data]) => !data.complete);
        if (incomplete.length) append("warn", "REVIEW", `${name} · ${incomplete.map(([p]) => providerLabel(p)).join("、")} 存在失败片段，需人工复核`);
        append(verdict === "allow" ? "ok" : verdict === "block" ? "error" : "warn", VERDICT_ZH[verdict], `${name} → ${VERDICT_ZH[verdict]}`);
        finish({ status: "done", report, verdict });
        return;
      }
      case "moderation.failed":
        setStages(s => {
          const next = { ...s };
          for (const id of STAGE_ORDER) if (next[id].state === "run") next[id] = { ...next[id], state: "fail" };
          return next;
        });
        append("error", "FAILED", `${name} · ${text || "处理失败"}`);
        finish({ status: "failed", error: text || "处理失败", verdict: "review" });
        return;
      case "moderation.rejected":
        // Another job is already running in the worker: put this video back and pause the queue.
        append("warn", "REJECT", text);
        if (current.current) {
          const id = current.current.id;
          current.current = null;
          setVideos(list => list.map(v => v.id === id ? { ...v, status: "queued", startedAt: undefined } : v));
        }
        setBusy(false); setQueueActive(false);
        return;
      case "worker.exited":
        setEngine("error"); setQueueActive(false);
        setStages(s => ({ ...s, engine: { id: "engine", state: "fail" } }));
        append("error", "ENGINE", text || "审核引擎已退出");
        finish({ status: "failed", error: text || "审核引擎已退出", verdict: "review" });
        return;
      case "worker.error":
        append("error", "ENGINE", text || "无效的后台命令");
        return;
      default:
        if (text) append("info", payload.type.toUpperCase(), text);
    }
  }, [addPaths, append, finish, preview]);

  useEffect(() => {
    let alive = true;
    if (preview) {
      const timer = window.setTimeout(() => { if (alive) handle({ type: "worker.ready", settings: DEMO_SETTINGS }); }, 250);
      return () => { alive = false; window.clearTimeout(timer); cancelDemo.current?.(); };
    }
    let dispose: (() => void) | undefined;
    async function connect() {
      dispose = await listen<WorkerEvent>("worker-event", ({ payload }) => { if (alive) handle(payload); });
      if (!alive) { dispose(); return; }
      await send({ action: "initialize" });
    }
    void connect().catch(error => {
      if (!alive) return;
      setEngine("error");
      setMessage(`连接失败：${String(error)}。请使用 npm run dev 打开桌面端。`);
      append("error", "ENGINE", `连接失败：${String(error)}`);
    });
    return () => { alive = false; dispose?.(); };
  }, [append, handle, preview, send]);

  // Queue driver: whenever the worker is idle and the queue is on, launch the next queued video.
  useEffect(() => {
    if (!queueActive || busy || current.current || !config.current) return;
    const next = videos.find(v => v.status === "queued");
    if (!next) {
      setQueueActive(false); setEngine(e => (e === "running" ? "ready" : e));
      setBatch(b => b && { ...b, finishedAt: Date.now() });
      append("ok", "BATCH", "队列已全部审核完毕");
      return;
    }
    const payload: ModerationRequest = { ...config.current, video_path: next.path };
    current.current = { ...next, status: "running" };
    setBusy(true); setEngine("running"); setMessage(`正在审核 ${next.name}…`);
    setStages(freshStages(payload.provider, true));
    setVideos(list => list.map(v => v.id === next.id ? { ...v, status: "running", startedAt: Date.now() } : v));
    append("info", "START", next.name);
    if (preview) {
      cancelDemo.current = simulateRun(payload, handle);
      return;
    }
    send({ action: "moderation_start", payload }).catch(error => {
      setEngine("error"); setQueueActive(false);
      setStages(s => ({ ...s, engine: { id: "engine", state: "fail" } }));
      append("error", "ENGINE", String(error));
      finish({ status: "failed", error: String(error), verdict: "review" });
    });
  }, [append, busy, finish, handle, preview, queueActive, send, videos]);

  function startQueue(run: RunConfig) {
    config.current = run;
    setBatch({ startedAt: Date.now(), asrEngine: run.settings.asr_engine });
    setQueueActive(true);
  }
  function stopQueue() {
    setQueueActive(false);
    append("warn", "QUEUE", "已暂停：当前视频审核完成后不再继续");
  }
  async function addFolder(directory?: string) {
    if (preview) { addPaths(demoVideos(6)); return; }
    if (!directory) return;
    try { await send({ action: "list_videos", payload: { directory } }); }
    catch (error) { append("error", "FOLDER", String(error)); }
  }
  function addVideos(paths: string[]) { addPaths(preview && !paths.length ? demoVideos(3) : paths); }
  function removeVideo(id: string) { setVideos(list => list.filter(v => v.id !== id || v.status !== "queued")); }
  function clearQueued() { setVideos(list => list.filter(v => v.status !== "queued")); }
  function clearFinished() { setVideos(list => list.filter(v => v.status === "queued" || v.status === "running")); }

  return { preview, settings, setSettings, busy, engine, message, videos, queueActive, log, stages, batch,
           startQueue, stopQueue, addVideos, addFolder, removeVideo, clearQueued, clearFinished };
}
