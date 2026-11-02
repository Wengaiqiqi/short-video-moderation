import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEMO_SETTINGS, demoThumbnail, demoVideos, simulateRun } from "./demo";
import { baseName, providerLabel, VERDICT_ZH, videoVerdict } from "./lib/report";
import type { LogEntry, ModerationRequest, Settings, Stage, StageId, VideoItem, WorkerEvent } from "./types";

export type EngineState = "connecting" | "ready" | "running" | "error";
export const STAGE_ORDER: StageId[] = ["engine", "prepare", "align", "jev", "openai", "report"];
export type Stages = Record<StageId, Stage>;
/** Everything in a request except the video; fixed when the queue starts. */
export type RunConfig = Omit<ModerationRequest, "video_path" | "job_id">;
export interface BatchInfo { startedAt: number; finishedAt?: number; asrEngine: Settings["asr_engine"] }

export function freshStages(provider?: ModerationRequest["provider"]): Stages {
  const stages = Object.fromEntries(STAGE_ORDER.map(id => [id, { id, state: "wait" }])) as Stages;
  stages.engine.state = "pass";
  if (provider === "jev") stages.openai.state = "skip";
  if (provider === "openai") stages.jev.state = "skip";
  return stages;
}

const MODEL_PROGRESS = /^(\w+): 完成 (\d+)\/(\d+)/;
const ASR_PROGRESS = /^语音识别 (\d+)\/(\d+)/;
const LOG_LIMIT = 500;
export const DEFAULT_VIDEO_CONCURRENCY = 11;

export function useModeration() {
  const preview = !isTauri();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [engine, setEngine] = useState<EngineState>("connecting");
  const [message, setMessage] = useState("正在连接审核引擎…");
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [queueActive, setQueueActive] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [stagesById, setStagesById] = useState<Record<string, Stages>>({});
  const [batch, setBatch] = useState<BatchInfo | null>(null);
  const sequence = useRef(0);
  /** Videos started and not yet finished (updated synchronously, unlike React state). */
  const active = useRef(new Map<string, VideoItem>());
  const config = useRef<RunConfig | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const videosRef = useRef<VideoItem[]>([]);
  const cancelDemo = useRef(new Map<string, () => void>());
  settingsRef.current = settings;
  videosRef.current = videos;

  const append = useCallback((level: LogEntry["level"], tag: string, text: string) => {
    const entry = { id: ++sequence.current, at: Date.now(), level, tag, text };
    setLog(previous => [...previous.slice(-(LOG_LIMIT - 1)), entry]);
  }, []);

  const send = useCallback(async (command: unknown) => {
    await invoke("send_worker_command", { command });
  }, []);

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

  const finish = useCallback((id: string, patch: Partial<VideoItem>) => {
    if (!active.current.delete(id)) return;
    cancelDemo.current.delete(id);
    setVideos(list => list.map(v => v.id === id ? { ...v, ...patch, finishedAt: Date.now() } : v));
  }, []);

  const updateStages = useCallback((id: string, change: (stages: Stages) => Stages) => {
    setStagesById(all => ({ ...all, [id]: change(all[id] ?? freshStages()) }));
  }, []);

  const handle = useCallback((payload: WorkerEvent) => {
    const text = payload.error || payload.message || "";
    switch (payload.type) {
      case "worker.ready":
        if (payload.settings) {
          const incoming = payload.settings;
          setSettings(s => s ?? { ...incoming, video_concurrency: incoming.video_concurrency ?? DEFAULT_VIDEO_CONCURRENCY,
                                  model_concurrency: incoming.model_concurrency ?? 8 });
        }
        setEngine("ready"); setMessage("就绪");
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
      case "worker.error":
        append("error", "ENGINE", text || "无效的后台命令");
        return;
      case "worker.exited":
        setEngine("error"); setQueueActive(false); setMessage(text);
        append("error", "ENGINE", text || "审核引擎已退出");
        for (const id of [...active.current.keys()]) finish(id, { status: "failed", error: text || "审核引擎已退出", verdict: "review" });
        return;
    }
    // Everything below belongs to one video.
    const id = payload.job_id;
    const item = id ? active.current.get(id) : undefined;
    if (!id || !item) return;
    if (text) setMessage(`${item.name} · ${text}`);
    switch (payload.type) {
      case "moderation.progress": {
        const msg = payload.message ?? "";
        const model = MODEL_PROGRESS.exec(msg);
        const asr = ASR_PROGRESS.exec(msg);
        updateStages(id, s => {
          const next = { ...s };
          if (model) {
            const [, provider, done, total] = model;
            next.prepare = { ...next.prepare, state: "pass" };
            next.align = { ...next.align, state: "pass" };
            if (provider === "jev" || provider === "openai") {
              next[provider] = { id: provider, state: done === total ? "pass" : "run", done: Number(done), total: Number(total) };
            }
          } else if (asr) {
            next.prepare = { id: "prepare", state: "run", done: Number(asr[1]), total: Number(asr[2]) };
          } else if (msg.startsWith("并行处理")) {
            next.prepare = { ...next.prepare, id: "prepare", state: "run" };
          } else if (msg.startsWith("按讲话时间")) {
            next.prepare = { ...next.prepare, state: "pass" };
            next.align = { id: "align", state: "run" };
          }
          return next;
        });
        // Keep the feed readable with many videos: log stage changes, not every window.
        if (model) {
          const [, provider, done, total] = model;
          if (done === "0") append("run", providerLabel(provider), `${item.name} · 开始分类（${total} 段）`);
          else if (done === total) append("run", providerLabel(provider), `${item.name} · 分类完成`);
        } else if (asr) {
          if (asr[1] === asr[2]) append("run", "ASR", `${item.name} · 语音识别 ${asr[2]} 段完成`);
        } else append("run", "PIPELINE", `${item.name} · ${msg}`);
        return;
      }
      case "moderation.completed": {
        const report = payload.report ?? undefined;
        const verdict = videoVerdict(report);
        updateStages(id, s => {
          const next = { ...s };
          for (const stage of STAGE_ORDER) if (next[stage].state === "run" || next[stage].state === "wait") next[stage] = { ...next[stage], state: "pass" };
          for (const [provider, data] of Object.entries(report?.providers ?? {})) {
            if (provider === "jev" || provider === "openai") {
              next[provider] = { id: provider, state: data.complete ? "pass" : "warn", done: data.segments.length, total: data.segments.length };
            }
          }
          return next;
        });
        const incomplete = Object.entries(report?.providers ?? {}).filter(([, data]) => !data.complete);
        if (incomplete.length) append("warn", "REVIEW", `${item.name} · ${incomplete.map(([p]) => providerLabel(p)).join("、")} 存在失败片段，需人工复核`);
        append(verdict === "allow" ? "ok" : verdict === "block" ? "error" : "warn", VERDICT_ZH[verdict], `${item.name} → ${VERDICT_ZH[verdict]}`);
        finish(id, { status: "done", report, verdict });
        return;
      }
      case "moderation.failed":
        updateStages(id, s => {
          const next = { ...s };
          for (const stage of STAGE_ORDER) if (next[stage].state === "run") next[stage] = { ...next[stage], state: "fail" };
          return next;
        });
        append("error", "FAILED", `${item.name} · ${text || "处理失败"}`);
        finish(id, { status: "failed", error: text || "处理失败", verdict: "review" });
        return;
      case "moderation.rejected":
        // The worker is at its limit: put the video back and pause the queue.
        append("warn", "REJECT", `${item.name} · ${text}`);
        active.current.delete(id);
        setVideos(list => list.map(v => v.id === id ? { ...v, status: "queued", startedAt: undefined } : v));
        setQueueActive(false);
        return;
      default:
        if (text) append("info", payload.type.toUpperCase(), text);
    }
  }, [addPaths, append, finish, preview, updateStages]);

  useEffect(() => {
    let alive = true;
    const demos = cancelDemo.current;
    if (preview) {
      const timer = window.setTimeout(() => { if (alive) handle({ type: "worker.ready", settings: DEMO_SETTINGS }); }, 250);
      return () => { alive = false; window.clearTimeout(timer); demos.forEach(cancel => cancel()); };
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

  const limit = Math.max(1, Math.min(32, Math.round(settings?.video_concurrency ?? DEFAULT_VIDEO_CONCURRENCY)));
  const running = videos.filter(v => v.status === "running").length;

  // Queue driver: keep up to `limit` videos in flight; the limit can change while the queue runs.
  useEffect(() => {
    if (!queueActive || !config.current) return;
    const slots = limit - active.current.size;
    const waiting = videos.filter(v => v.status === "queued" && !active.current.has(v.id));
    if (!waiting.length) {
      if (active.current.size === 0) {
        setQueueActive(false); setEngine(e => (e === "running" ? "ready" : e));
        setBatch(b => b && { ...b, finishedAt: Date.now() });
        append("ok", "BATCH", "队列已全部审核完毕");
      }
      return;
    }
    if (slots <= 0) return;
    const launch = waiting.slice(0, slots);
    const now = Date.now();
    for (const item of launch) active.current.set(item.id, { ...item, status: "running" });
    setEngine("running");
    setVideos(list => list.map(v => launch.some(l => l.id === v.id) ? { ...v, status: "running", startedAt: now } : v));
    setStagesById(all => ({ ...all, ...Object.fromEntries(launch.map(l => [l.id, freshStages(config.current!.provider)])) }));
    for (const item of launch) {
      const payload: ModerationRequest = { ...config.current, video_path: item.path, job_id: item.id };
      append("info", "START", item.name);
      if (preview) {
        cancelDemo.current.set(item.id, simulateRun(payload, handle));
        continue;
      }
      send({ action: "moderation_start", payload }).catch(error => {
        append("error", "ENGINE", String(error));
        finish(item.id, { status: "failed", error: String(error), verdict: "review" });
      });
    }
  }, [append, finish, handle, limit, preview, queueActive, send, videos]);

  function startQueue(run: RunConfig) {
    config.current = run;
    setBatch(b => (queueActive && b ? b : { startedAt: Date.now(), asrEngine: run.settings.asr_engine }));
    setQueueActive(true);
  }
  function stopQueue() {
    setQueueActive(false);
    append("warn", "QUEUE", "已暂停：正在审核的视频完成后不再继续");
  }
  async function addFolder(directory?: string) {
    if (preview) { addPaths(demoVideos(12)); return; }
    if (!directory) return;
    try { await send({ action: "list_videos", payload: { directory } }); }
    catch (error) { append("error", "FOLDER", String(error)); }
  }
  function addVideos(paths: string[]) { addPaths(preview && !paths.length ? demoVideos(4) : paths); }
  function removeVideo(id: string) { setVideos(list => list.filter(v => v.id !== id || v.status !== "queued")); }
  function clearQueued() { setVideos(list => list.filter(v => v.status !== "queued")); }

  return { preview, settings, setSettings, busy: running > 0, running, limit, engine, message, videos, queueActive,
           log, stagesById, batch, startQueue, stopQueue, addVideos, addFolder, removeVideo, clearQueued };
}
