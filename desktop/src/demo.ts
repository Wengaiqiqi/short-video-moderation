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
  asr_engine: "faster-whisper", asr_model: "small", asr_language: "zh", asr_device: "cpu", asr_compute_type: "int8",
  mimo_base_url: "https://api.xiaomimimo.com/v1", mimo_model: "mimo-v2.5-asr", asr_concurrency: 3,
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

/** Each demo video gets a profile from its path: clean, borderline or clearly violating. */
export function demoReport(request: Pick<ModerationRequest, "provider" | "modality" | "segment_seconds" | "video_path">): ModerationReport {
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
    report_path: "DEMO/report.json", modality: request.modality, input_hash: `demo${seed.toString(16)}`,
    policy: { version: "short-video-research-v1", review_threshold: 0.4, block_threshold: 0.8, categories: Object.fromEntries(CATEGORIES.map(c => [c, {}])) },
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
      if (provider === "openai" && seed % 7 === 3 && index === 2) return { ...row, status: "failed", action: "review", error_type: "RuntimeError" };
      const d = ((start + end) / 2 / duration - hotCenter) / 0.12;
      const probabilities = Object.fromEntries(CATEGORIES.map(c => {
        const base = 0.02 + next() * 0.1;
        const hot = c === hotCategory ? Math.min(0.99, peak * Math.exp(-d * d) + bias) : 0;
        return [c, Math.round(Math.max(base, hot) * 1000) / 1000];
      }));
      const top = Math.max(...Object.values(probabilities));
      return { ...row, probabilities, action: top >= 0.8 ? "block" : top >= 0.4 ? "review" : "allow" };
    });
    report.providers[provider] = { complete: segments.every(r => r.status === "completed"), segments };
  }
  return report;
}

/** Emits the same event sequence as desktop.py for one video, on a timer. Returns a cancel function. */
export function simulateRun(request: ModerationRequest, emit: (event: WorkerEvent) => void) {
  const report = demoReport(request);
  const steps: [number, WorkerEvent][] = [
    [300, { type: "moderation.progress", message: "并行处理：画面抽样与音轨转写" }],
    [1300, { type: "moderation.progress", message: "按讲话时间组合画面；补齐静音区间" }],
  ];
  let at = 1800;
  for (const [provider, result] of Object.entries(report.providers)) {
    result.segments.forEach((_, i) => {
      steps.push([at, { type: "moderation.progress", message: `${provider}: 片段 ${i + 1}/${result.segments.length}` }]);
      at += 70;
    });
  }
  steps.push([at + 200, { type: "moderation.completed", message: report.report_path, report, video_path: request.video_path }]);
  const timers = steps.map(([delay, event]) => window.setTimeout(() => emit(event), delay));
  return () => timers.forEach(t => window.clearTimeout(t));
}
