import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DEMO_POLICY, DEMO_PRESETS, DEMO_SETTINGS, demoRequest, demoThumbnail, demoVideos, simulateEvaluate, simulateRun } from "./demo";
import { baseName, providerLabel, VERDICT_ZH, videoVerdict } from "./lib/report";
import type { LogEntry, ModerationReport, ModerationRequest, ReviewDecision, Settings, Stage, StageId, VideoItem, WorkerEvent } from "./types";

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
const LONG_VIDEO_SEC = 600;
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
  const pending = useRef(new Map<string, (event: WorkerEvent) => void>());
  settingsRef.current = settings;
  videosRef.current = videos;

  const append = useCallback((level: LogEntry["level"], tag: string, text: string) => {
    const entry = { id: ++sequence.current, at: Date.now(), level, tag, text };
    setLog(previous => [...previous.slice(-(LOG_LIMIT - 1)), entry]);
  }, []);

  const send = useCallback(async (command: unknown) => {
    await invoke("send_worker_command", { command });
  }, []);

  /** Ask the worker something and wait for the event carrying the same request_id. */
  const request = useCallback(async (action: string, payload: Record<string, unknown>): Promise<WorkerEvent> => {
    if (preview) return demoRequest(action, payload);
    const id = `r${++sequence.current}`;
    const answer = new Promise<WorkerEvent>(resolve => pending.current.set(id, resolve));
    await send({ action, payload: { ...payload, request_id: id } });
    return answer;
  }, [preview, send]);

  const patchVideo = useCallback((id: string, patch: Partial<VideoItem> | ((v: VideoItem) => Partial<VideoItem>)) => {
    setVideos(list => list.map(v => v.id === id ? { ...v, ...(typeof patch === "function" ? patch(v) : patch) } : v));
  }, []);

  const requestThumbnail = useCallback((item: VideoItem) => {
    if (preview) {
      window.setTimeout(() => patchVideo(item.id, { thumb: demoThumbnail(item.path),
        duration_sec: /长视频/.test(item.name) ? 1500 : 60 }), 120);
      if (/长视频/.test(item.name)) window.setTimeout(() => void splitLong(item, 1500), 200);
      return;
    }
    const s = settingsRef.current;
    void send({ action: "thumbnail", payload: { id: item.id, video_path: item.path, ffmpeg_path: s?.ffmpeg_path || null,
                                                ffprobe_path: s?.ffprobe_path || null } })
      .catch(error => append("warn", "COVER", String(error)));
  }, [append, patchVideo, preview, send]); // eslint-disable-line react-hooks/exhaustive-deps

  const addPaths = useCallback((paths: string[]) => {
    const waiting = new Set(videosRef.current.filter(v => v.status === "queued" || v.status === "running").map(v => v.path));
    const fresh: VideoItem[] = [];
    for (const path of paths) {
      const clean = path.trim();
      if (!clean || waiting.has(clean)) continue;
      waiting.add(clean);
      fresh.push({ id: `v${++sequence.current}`, path: clean, name: baseName(clean), status: "queued" });
    }
    if (!fresh.length) return;
    videosRef.current = [...videosRef.current, ...fresh];
    setVideos(list => [...list, ...fresh]);
    append("info", "QUEUE", `加入 ${fresh.length} 个视频`);
    fresh.forEach(requestThumbnail);
  }, [append, requestThumbnail]);

  /** Replace a queued video longer than 10 minutes by its parts (cut at key frames, no re-encoding). */
  async function splitLong(item: VideoItem, duration: number) {
    const s = settingsRef.current;
    append("info", "SPLIT", `${item.name} · ${Math.round(duration / 60)} 分钟，正在切分`);
    const answer = await request("split_video", { id: item.id, video_path: item.path, duration_sec: duration, part_sec: 590,
                                                 ffmpeg_path: s?.ffmpeg_path || null, ffprobe_path: s?.ffprobe_path || null });
    const parts = (answer.parts as { path: string; start_sec: number; end_sec: number }[] | undefined) ?? [];
    if (answer.error || !parts.length) { append("error", "SPLIT", `${item.name} · ${String(answer.error ?? "切分失败")}`); return; }
    const pieces: VideoItem[] = parts.map((p, i) => ({
      id: `v${++sequence.current}`, path: p.path, name: `${item.name} · ${i + 1}/${parts.length}`, status: "queued",
      thumb: preview ? demoThumbnail(p.path) : videosRef.current.find(v => v.id === item.id)?.thumb ?? item.thumb,
      duration_sec: p.end_sec - p.start_sec, part: { index: i + 1, total: parts.length, start_sec: p.start_sec, end_sec: p.end_sec, source: item.path } }));
    setVideos(list => list.flatMap(v => v.id === item.id && v.status === "queued" ? pieces : [v]));
    append("ok", "SPLIT", `${item.name} → ${parts.length} 段`);
    if (!preview) pieces.forEach(requestThumbnail);
  }

  const finish = useCallback((id: string, patch: Partial<VideoItem>) => {
    if (!active.current.delete(id)) return;
    cancelDemo.current.delete(id);
    setVideos(list => list.map(v => v.id === id ? { ...v, ...patch, finishedAt: Date.now() } : v));
  }, []);

  const updateStages = useCallback((id: string, change: (stages: Stages) => Stages) => {
    setStagesById(all => ({ ...all, [id]: change(all[id] ?? freshStages()) }));
  }, []);

  const handle = useCallback((payload: WorkerEvent) => {
    if (payload.request_id && pending.current.has(payload.request_id)) {
      pending.current.get(payload.request_id)!(payload);
      pending.current.delete(payload.request_id);
      return;
    }
    const text = (payload.error || payload.message || "") as string;
    switch (payload.type) {
      case "worker.ready":
        if (payload.settings) {
          const incoming = payload.settings;
          setSettings(s => s ?? { ...incoming, video_concurrency: incoming.video_concurrency ?? DEFAULT_VIDEO_CONCURRENCY });
        }
        setEngine("ready"); setMessage("就绪");
        append("ok", "ENGINE", preview ? "浏览器预览：使用 DEMO 示例引擎" : "审核引擎就绪");
        return;
      case "video.thumbnail": {
        const duration = typeof payload.duration_sec === "number" ? payload.duration_sec : undefined;
        patchVideo(String(payload.id), v => ({ thumb: (payload.data_url as string) || v.thumb, duration_sec: duration ?? v.duration_sec }));
        const item = videosRef.current.find(v => v.id === payload.id);
        if (item && duration && duration > LONG_VIDEO_SEC && !item.part && item.status === "queued") {
          if (settingsRef.current?.split_long_videos !== false) void splitLong(item, duration);
          else append("warn", "LONG", `${item.name} 超过 10 分钟，未开启自动切分`);
        }
        return;
      }
      case "videos.listed":
        if (payload.error) { append("error", "FOLDER", String(payload.error)); return; }
        if (!(payload.videos as string[] | undefined)?.length) { append("warn", "FOLDER", `文件夹中没有视频：${String(payload.directory ?? "")}`); return; }
        addPaths(payload.videos as string[]);
        return;
      case "worker.error":
        append("error", "ENGINE", text || "无效的后台命令");
        return;
      case "moderation.cancel_requested":
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
          } else if (msg.startsWith("复用已准备")) {
            next.prepare = { ...next.prepare, state: "pass" };
            next.align = { ...next.align, state: "pass" };
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
        const report = (payload.report as ModerationReport | undefined) ?? undefined;
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
        append(verdict === "allow" ? "ok" : verdict === "block" ? "error" : "warn", payload.cached ? "已审" : VERDICT_ZH[verdict],
               `${item.name} → ${VERDICT_ZH[verdict]}${payload.cached ? "（复用此前结果）" : ""}`);
        finish(id, { status: "done", report, verdict, error: undefined, cached: !!payload.cached });
        return;
      }
      case "moderation.cancelled":
        updateStages(id, s => Object.fromEntries(STAGE_ORDER.map(k => [k, s[k].state === "run" ? { ...s[k], state: "skip" } : s[k]])) as Stages);
        append("warn", "CANCEL", `${item.name} · 已取消`);
        // A cancelled re-run keeps the earlier result; a cancelled first run has none.
        finish(id, { status: item.report ? "done" : "cancelled" });
        return;
      case "moderation.failed":
        updateStages(id, s => {
          const next = { ...s };
          for (const stage of STAGE_ORDER) if (next[stage].state === "run") next[stage] = { ...next[stage], state: "fail" };
          return next;
        });
        append("error", "FAILED", `${item.name} · ${text || "处理失败"}`);
        finish(id, item.report ? { status: "done", error: text || "处理失败" } : { status: "failed", error: text || "处理失败", verdict: "review" });
        return;
      case "moderation.rejected":
        // The worker is at its limit: put the video back and pause the queue.
        append("warn", "REJECT", `${item.name} · ${text}`);
        active.current.delete(id);
        patchVideo(id, v => ({ status: v.report ? "done" : "queued", startedAt: undefined }));
        setQueueActive(false);
        return;
      default:
        if (text) append("info", payload.type.toUpperCase(), text);
    }
  }, [addPaths, append, finish, patchVideo, preview, updateStages]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    const demos = cancelDemo.current;
    if (preview) {
      let saved: Partial<Settings> = {};
      try { saved = JSON.parse(localStorage.getItem("svm-demo-settings") ?? "{}"); } catch { /* preview only */ }
      const timer = window.setTimeout(() => {
        if (alive) handle({ type: "worker.ready", settings: { ...DEMO_SETTINGS, policy: DEMO_POLICY, category_presets: DEMO_PRESETS, ...saved } });
      }, 250);
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

  // Settings are saved (without keys, unless the keychain is chosen) shortly after each change.
  const loaded = useRef(false);
  useEffect(() => {
    if (!settings) return;
    if (!loaded.current) { loaded.current = true; return; }
    const timer = window.setTimeout(() => {
      const { category_presets, keychain_available, stored_keys, ...persist } = settings;
      void request("save_settings", { settings: persist }).then(answer => {
        if (answer.stored_keys) setSettings(s => s && { ...s, stored_keys: answer.stored_keys as Record<string, boolean> });
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [settings, request]);

  const limit = Math.max(1, Math.min(32, Math.round(settings?.video_concurrency ?? DEFAULT_VIDEO_CONCURRENCY)));
  const running = videos.filter(v => v.status === "running").length;

  /** Start one job for a video: a full review, or a re-judgement of its prepared inputs. */
  const launch = useCallback((item: VideoItem, run: RunConfig, evaluate?: { report_path: string; retry_failed?: boolean }) => {
    active.current.set(item.id, { ...item, status: "running" });
    setEngine("running");
    patchVideo(item.id, { status: "running", startedAt: Date.now(), error: undefined });
    setStagesById(all => ({ ...all, [item.id]: freshStages(run.provider) }));
    const payload: ModerationRequest & Record<string, unknown> = { ...run, video_path: item.path, job_id: item.id, ...evaluate };
    append("info", evaluate ? (evaluate.retry_failed ? "RETRY" : "RERUN") : "START", item.name);
    if (preview) {
      cancelDemo.current.set(item.id, evaluate ? simulateEvaluate(payload, handle) : simulateRun(payload, handle));
      return;
    }
    send({ action: evaluate ? "moderation_evaluate" : "moderation_start", payload }).catch(error => {
      append("error", "ENGINE", String(error));
      finish(item.id, { status: "failed", error: String(error), verdict: "review" });
    });
  }, [append, finish, handle, patchVideo, preview, send]);

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
    for (const item of waiting.slice(0, slots)) launch(item, config.current);
  }, [append, launch, limit, queueActive, videos]);

  function startQueue(run: RunConfig) {
    config.current = run;
    setBatch(b => (queueActive && b ? b : { startedAt: Date.now(), asrEngine: run.settings.asr_engine }));
    setQueueActive(true);
  }
  function stopQueue() {
    setQueueActive(false);
    append("warn", "QUEUE", "已暂停：正在审核的视频完成后不再继续");
  }
  /** Stop one running video now (or take a queued one out). */
  function cancelVideo(id: string) {
    const item = videosRef.current.find(v => v.id === id);
    if (!item) return;
    if (item.status === "queued") { patchVideo(id, { status: "cancelled" }); return; }
    if (preview) { cancelDemo.current.get(id)?.(); handle({ type: "moderation.cancelled", job_id: id }); return; }
    void send({ action: "moderation_cancel", payload: { job_id: id } });
  }
  /** Pause the queue and stop every running video. */
  function cancelAll() {
    setQueueActive(false);
    if (preview) { for (const id of [...active.current.keys()]) cancelVideo(id); }
    else void send({ action: "moderation_cancel", payload: {} });
    append("warn", "CANCEL", "全部停止");
  }
  /** Put a failed or cancelled video back in the queue (full review again). */
  function requeue(id: string, run: RunConfig) {
    patchVideo(id, { status: "queued", error: undefined, report: undefined, verdict: undefined, cached: false });
    if (!queueActive) startQueue(run);
  }
  /** Re-send only the windows that failed, reusing the prepared frames and transcript. */
  function retryFailed(id: string, run: RunConfig) {
    const item = videosRef.current.find(v => v.id === id);
    if (!item?.report || active.current.has(id)) return;
    launch(item, run, { report_path: item.report.report_path, retry_failed: true });
  }
  /** Judge the prepared inputs again with another provider group or modality. */
  function reevaluate(id: string, run: RunConfig) {
    const item = videosRef.current.find(v => v.id === id);
    if (!item?.report || active.current.has(id)) return;
    launch(item, run, { report_path: item.report.report_path });
  }
  async function setReview(id: string, decision: ReviewDecision["decision"] | null, note = "") {
    const item = videosRef.current.find(v => v.id === id);
    if (!item?.report) return;
    const answer = await request("save_review", { report_path: item.report.report_path, decision, note });
    if (answer.error) { append("error", "REVIEW", String(answer.error)); return; }
    patchVideo(id, { review: (answer.review as ReviewDecision | null) ?? null });
    append("ok", "人工", `${item.name} → ${decision ? VERDICT_ZH[decision] : "撤销终判"}`);
  }
  /** Load earlier results from the results folder (newest first). */
  async function loadHistory() {
    const root = settingsRef.current?.output_root;
    if (!root) return;
    const answer = await request("list_history", { output_root: root });
    if (answer.error) { append("error", "HISTORY", String(answer.error)); return; }
    const entries = (answer.entries as { report: ModerationReport; review: ReviewDecision | null; finished_at: number }[]) ?? [];
    const known = new Set(videosRef.current.map(v => v.report?.report_path).filter(Boolean));
    const fresh: VideoItem[] = entries.filter(e => !known.has(e.report.report_path)).map(e => ({
      id: `h${++sequence.current}`, path: e.report.video_path ?? e.report.report_path, name: baseName(e.report.video_path ?? "历史结果"),
      status: "done", report: e.report, verdict: videoVerdict(e.report), review: e.review, history: true,
      finishedAt: e.finished_at, duration_sec: e.report.duration_sec }));
    if (!fresh.length) return;
    setVideos(list => [...fresh, ...list]);
    append("info", "HISTORY", `读取历史结果 ${fresh.length} 个`);
    fresh.slice(0, 40).forEach(requestThumbnail);
  }
  // History is read once the engine is ready.
  const historyLoaded = useRef(false);
  useEffect(() => {
    if (engine === "ready" && settings && !historyLoaded.current) { historyLoaded.current = true; void loadHistory(); }
  }, [engine, settings]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addFolder(directory?: string) {
    if (preview) { addPaths(demoVideos(12)); return; }
    if (!directory) return;
    try { await send({ action: "list_videos", payload: { directory } }); }
    catch (error) { append("error", "FOLDER", String(error)); }
  }
  function addVideos(paths: string[]) { addPaths(preview && !paths.length ? [...demoVideos(3), "D:/videos/demo/长视频-直播回放.mp4"] : paths); }
  function removeVideo(id: string) { setVideos(list => list.filter(v => v.id !== id || (v.status !== "queued" && v.status !== "cancelled"))); }
  function clearQueued() { setVideos(list => list.filter(v => v.status !== "queued" && v.status !== "cancelled")); }

  return { preview, settings, setSettings, busy: running > 0, running, limit, engine, message, videos, queueActive,
           log, stagesById, batch, startQueue, stopQueue, addVideos, addFolder, removeVideo, clearQueued,
           cancelVideo, cancelAll, requeue, retryFailed, reevaluate, setReview, loadHistory, request };
}
