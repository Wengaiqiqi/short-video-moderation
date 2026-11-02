/**
 * Browser preview only (`npm run web:dev` outside Tauri). Plays synthetic runs through the same
 * event handler as the real worker so the layout can be reviewed without models or API keys.
 * Everything produced here is labelled DEMO in the UI and is never a moderation result.
 */
import type { ModerationReport, ModerationRequest, ModerationRow, Settings, WorkerEvent } from "./types";

export const DEMO_SETTINGS: Settings = {
  output_root: "~/.cache/short-video-moderation/runtime/results",
  jev_base_url: "https://api.typesafe.ai/v1", jev_model: "jev-1.14.0",
  llm_base_url: "https://api.openai.com/v1", llm_model: "gpt-4o-mini",
  asr_engine: "mimo-cloud", asr_model: "small", asr_language: "zh", asr_device: "cpu", asr_compute_type: "int8",
  mimo_base_url: "https://api.xiaomimimo.com/v1", mimo_model: "mimo-v2.5-asr",
  video_concurrency: 11,
  skip_reviewed: true, stop_on_block: false, split_long_videos: true, remember_keys: false, keychain_available: false,
  ffmpeg_path: "", ffprobe_path: "",
};

const NAMES = ["街头采访", "开箱测评", "宠物日常", "球赛集锦", "户外徒步", "厨房教程", "游戏实况", "旅行vlog", "舞蹈翻跳", "新闻短评", "手工制作", "健身打卡"];
let demoCounter = 0;
export function demoVideos(count: number) {
  return Array.from({ length: count }, () => `D:/videos/demo/${String(++demoCounter).padStart(2, "0")}-${NAMES[(demoCounter - 1) % NAMES.length]}.mp4`);
}

function hash(text: string) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** A synthetic cover: gradient, horizon and a few shapes, seeded by the path. */
export function demoThumbnail(path: string) {
  const next = random(hash(path));
  const canvas = document.createElement("canvas");
  canvas.width = 160; canvas.height = 160;
  const g = canvas.getContext("2d");
  if (!g) return undefined;
  const hue = Math.floor(next() * 360);
  const sky = g.createLinearGradient(0, 0, 0, 160);
  sky.addColorStop(0, `hsl(${hue} 45% 32%)`);
  sky.addColorStop(1, `hsl(${(hue + 40) % 360} 35% 12%)`);
  g.fillStyle = sky; g.fillRect(0, 0, 160, 160);
  g.fillStyle = `hsl(${(hue + 180) % 360} 30% 18%)`;
  g.fillRect(0, 96 + next() * 30, 160, 80);
  for (let i = 0; i < 4; i++) {
    g.fillStyle = `hsla(${(hue + i * 70) % 360} 70% ${55 + next() * 20}% / .75)`;
    g.beginPath();
    g.arc(next() * 160, 40 + next() * 90, 10 + next() * 26, 0, Math.PI * 2);
    g.fill();
  }
  return canvas.toDataURL("image/jpeg", 0.8);
}

function windows(maxSeconds: number, total: number, seed: number) {
  const next = random(seed);
  const out: [number, number][] = [];
  let t = 0;
  while (t < total) {
    const length = Math.min(maxSeconds, 1.4 + next() * 7.2, total - t);
    out.push([t, t + length]);
    t += length;
  }
  return out;
}

const CATEGORIES = ["violence", "hate", "harassment"];
const LABELS: Record<string, string> = { violence: "暴力", hate: "仇恨", harassment: "骚扰" };
export const DEMO_POLICY = {
  version: "short-video-research-v1", review_threshold: 0.65, block_threshold: 0.8,
  categories: Object.fromEntries(CATEGORIES.map(c => [c, { label: LABELS[c], question: `Does this segment contain ${c}?`,
    positive: `Clear ${c}.`, negative: `No ${c}.` }])),
};

/** Each demo video gets a profile from its path: clean, borderline or clearly violating. */
export function demoReport(request: Pick<ModerationRequest, "provider" | "modality" | "segment_seconds" | "video_path">,
                           options: { fixFailures?: boolean } = {}): ModerationReport {
  const seed = hash(request.video_path);
  // 0,1 clean · 2,3 borderline · 4 violating; demo files cycle through a fixed mix.
  const index = Number(/\/(\d+)-/.exec(request.video_path)?.[1] ?? NaN);
  const profile = Number.isFinite(index) ? [0, 2, 4, 1, 0, 3, 0, 4, 1, 2, 0, 3][(index - 1) % 12] : seed % 5;
  const peak = profile < 2 ? 0.22 : profile < 4 ? 0.58 : 0.93;
  const spans = windows(Math.max(1, Math.min(30, request.segment_seconds || 8)), 30 + (seed % 60), seed);
  const hotCenter = (seed % 1000) / 1000;
  const hotCategory = CATEGORIES[seed % 3];
  const providers = request.provider === "both" ? ["jev", "openai"] : [request.provider];
  const report: ModerationReport = {
    report_path: `DEMO/${seed.toString(16)}/${Date.now()}/report.json`, modality: request.modality, input_hash: `demo${seed.toString(16)}`,
    policy: DEMO_POLICY, video_path: request.video_path, created_at: new Date().toISOString(),
    sampling: { interval_sec: 0.5, segment_sec: request.segment_seconds }, providers: {},
  };
  const duration = spans[spans.length - 1][1];
  for (const provider of providers) {
    const next = random(seed + (provider === "jev" ? 11 : 29));
    const bias = provider === "jev" ? 0 : 0.05;
    const segments: ModerationRow[] = spans.map(([start, end], index) => {
      const row: ModerationRow = {
        segment_id: index + 1, start_sec: start, end_sec: end, status: "completed", action: "allow",
        elapsed_sec: Math.round((0.6 + next() * 1.8) * 1000) / 1000, visual_evidence: "sampled",
        model: provider === "jev" ? DEMO_SETTINGS.jev_model : DEMO_SETTINGS.llm_model,
      };
      if (provider === "openai" && seed % 7 === 3 && index === 2 && !options.fixFailures) return { ...row, status: "failed", action: "review", error_type: "http_429" };
      row.usage = { input_tokens: Math.round(1100 + next() * 1600), output_tokens: Math.round(20 + next() * 30) };
      const d = ((start + end) / 2 / duration - hotCenter) / 0.12;
      const probabilities = Object.fromEntries(CATEGORIES.map(c => {
        const base = 0.02 + next() * 0.1;
        const hot = c === hotCategory ? Math.min(0.99, peak * Math.exp(-d * d) + bias) : 0;
        return [c, Math.round(Math.max(base, hot) * 1000) / 1000];
      }));
      const top = Math.max(...Object.values(probabilities));
      return { ...row, probabilities, action: top >= 0.8 ? "block" : top >= 0.65 ? "review" : "allow" };
    });
    const usage = segments.reduce((a, r) => ({ input_tokens: a.input_tokens + (r.usage?.input_tokens ?? 0),
      output_tokens: a.output_tokens + (r.usage?.output_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0 });
    report.providers[provider] = { complete: segments.every(r => r.status === "completed"), segments, usage };
  }
  report.duration_sec = duration;
  report.asr_statistics = { chunks: spans.length + 2, uploaded: spans.length, uploaded_seconds: Math.round(duration * 0.8), skipped_silent: 2, failed: 0 };
  return report;
}

/** Emits the same event sequence as desktop.py for one video (tagged with its job id). Returns a cancel function. */
export function simulateRun(request: ModerationRequest, emit: (event: WorkerEvent) => void) {
  const report = demoReport(request);
  const next = random(hash(request.video_path) + 5);
  const tag = { job_id: request.job_id, video_path: request.video_path };
  const progress = (message: string): WorkerEvent => ({ type: "moderation.progress", message, ...tag });
  const speed = 0.7 + next() * 0.9;
  const chunks = 3 + Math.floor(next() * 6);
  const steps: [number, WorkerEvent][] = [[200, progress("并行处理：画面抽样与音轨转写")], [260, progress(`语音识别 0/${chunks}`)]];
  for (let i = 1; i <= chunks; i++) steps.push([260 + i * 180 * speed, progress(`语音识别 ${i}/${chunks}`)]);
  let at = 300 + chunks * 180 * speed;
  steps.push([at, progress("按讲话时间组合画面；补齐静音区间")]);
  at += 350;
  // Both providers run at the same time, a few windows in flight each.
  let end = at;
  for (const [provider, result] of Object.entries(report.providers)) {
    const total = result.segments.length;
    steps.push([at, progress(`${provider}: 完成 0/${total}`)]);
    for (let i = 1; i <= total; i++) steps.push([at + i * (90 + next() * 60) * speed, progress(`${provider}: 完成 ${i}/${total}`)]);
    end = Math.max(end, steps[steps.length - 1][0]);
  }
  steps.push([end + 200, { type: "moderation.completed", message: report.report_path, report, ...tag }]);
  const timers = steps.map(([delay, event]) => window.setTimeout(() => emit(event), delay));
  return () => timers.forEach(t => window.clearTimeout(t));
}

/** Re-judging prepared inputs (retry or another modality): no sampling or ASR stage. */
export function simulateEvaluate(request: ModerationRequest & { retry_failed?: boolean }, emit: (event: WorkerEvent) => void) {
  const report = demoReport(request, { fixFailures: true });
  const tag = { job_id: request.job_id, video_path: request.video_path };
  const progress = (message: string): WorkerEvent => ({ type: "moderation.progress", message, ...tag });
  const steps: [number, WorkerEvent][] = [[150, progress("复用已准备的画面与转写")]];
  let end = 300;
  for (const [provider, result] of Object.entries(report.providers)) {
    const total = request.retry_failed ? 1 : result.segments.length;
    steps.push([300, progress(`${provider}: 完成 0/${total}`)]);
    for (let i = 1; i <= total; i++) steps.push([300 + i * 80, progress(`${provider}: 完成 ${i}/${total}`)]);
    end = Math.max(end, 300 + total * 80);
  }
  steps.push([end + 200, { type: "moderation.completed", message: report.report_path, report, ...tag }]);
  const timers = steps.map(([delay, event]) => window.setTimeout(() => emit(event), delay));
  return () => timers.forEach(t => window.clearTimeout(t));
}

const SPEECH = ["大家好，今天带你们看看这个地方。", "你再说一遍试试？", "这个东西真的太好用了，链接在评论区。",
  "别跑！站住！", "我们下次再见。", "（背景音乐）"];

/** Request/response commands of the real worker, answered locally. */
export function demoRequest(action: string, payload: Record<string, unknown>): Promise<WorkerEvent> {
  const reply = (fields: Record<string, unknown>, delay = 200) =>
    new Promise<WorkerEvent>(resolve => window.setTimeout(() => resolve({ type: action, ...fields }), delay));
  switch (action) {
    case "segment_evidence": {
      const id = Number(payload.segment_id);
      const path = String(payload.video_path ?? payload.report_path);
      return reply({ segment_id: id, start_sec: Number(payload.start_sec ?? 0), end_sec: Number(payload.end_sec ?? 0),
        speech_text: SPEECH[id % SPEECH.length], audio_status: "transcribed", alignment_precision: "speech_chunk", frame_count: 6,
        frames: Array.from({ length: 6 }, (_, i) => ({ time_sec: Number(payload.start_sec ?? 0) + i * 0.8, data_url: demoThumbnail(`${path}#${id}-${i}`) })) });
    }
    case "segment_clip":
      return reply({ error: "DEMO 预览不提供片段视频；桌面端会用 FFmpeg 截取该片段" });
    case "save_review":
      return reply({ report_path: payload.report_path, review: payload.decision
        ? { decision: payload.decision, note: payload.note ?? "", at: new Date().toISOString() } : null }, 80);
    case "list_history": {
      const entries = [1, 2, 3].map(i => {
        const path = `D:/videos/history/${String(i).padStart(2, "0")}-往期素材.mp4`;
        const report = demoReport({ provider: "both", modality: "multimodal", segment_seconds: 8, video_path: path });
        return { report, review: i === 2 ? { decision: "allow", note: "人工复核：剧情表演", at: "2026-10-30T10:00:00" } : null,
                 runs: 1, finished_at: Date.now() - i * 86400000 };
      });
      return reply({ entries }, 300);
    }
    case "save_settings":
      try { localStorage.setItem("svm-demo-settings", JSON.stringify(payload.settings)); } catch { /* preview only */ }
      return reply({ stored_keys: {} }, 50);
    case "split_video": {
      const duration = Number(payload.duration_sec ?? 1500);
      const count = Math.ceil(duration / 590);
      const source = String(payload.video_path);
      return reply({ id: payload.id, parts: Array.from({ length: count }, (_, i) => ({
        path: source.replace(/(\.\w+)$/, `-part${String(i).padStart(3, "0")}$1`), start_sec: i * 590,
        end_sec: Math.min(duration, (i + 1) * 590) })) }, 400);
    }
    default:
      return reply({ error: "DEMO 预览不支持该操作" });
  }
}

export const DEMO_PRESETS = {
  sexual: { label: "色情", question: "Does this segment show sexual activity, sexualized nudity or sexually explicit speech?",
            positive: "Explicit sexual acts or sexualized nudity.", negative: "Non-sexual nudity or swimwear." },
  gambling: { label: "赌博", question: "Does this segment promote gambling or illegal betting services?",
              positive: "Advertising or inviting viewers to gambling platforms.", negative: "Games without stakes." },
  fraud_ads: { label: "诈骗引流", question: "Does this segment lure viewers off-platform or into scams?",
               positive: "Private contact details, get-rich-quick or investment scams.", negative: "Legitimate labelled ads." },
};
