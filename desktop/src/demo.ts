/**
 * Browser preview only (`npm run web:dev` outside Tauri). Plays a synthetic run through the same
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
export const DEMO_VIDEO = "D:/videos/demo-sample.mp4";

function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

/** Speech-driven windows of uneven length, like align_evidence produces. */
function windows(maxSeconds: number) {
  const next = random(7);
  const out: [number, number][] = [];
  let t = 0;
  while (t < 96) {
    const length = Math.min(maxSeconds, 1.4 + next() * 7.2, 96 - t);
    out.push([t, t + length]);
    t += length;
  }
  return out;
}

const HOT: Record<string, [number, number, number][]> = {
  violence: [[40, 9, 0.93], [58, 4, 0.55]],
  hate: [[22, 5, 0.47]],
  harassment: [[71, 6, 0.86], [86, 3, 0.44]],
};

function score(category: string, mid: number, noise: number, bias: number) {
  let value = 0.03 + noise * 0.12;
  for (const [center, width, peak] of HOT[category] ?? []) {
    const d = (mid - center) / width;
    value = Math.max(value, peak * Math.exp(-d * d) + bias);
  }
  return Math.round(Math.min(0.99, Math.max(0.001, value)) * 1000) / 1000;
}

export function demoReport(request: Pick<ModerationRequest, "provider" | "modality" | "segment_seconds">): ModerationReport {
  const spans = windows(Math.max(1, Math.min(30, request.segment_seconds || 8)));
  const providers = request.provider === "both" ? ["jev", "openai"] : [request.provider];
  const policy = {
    version: "short-video-research-v1", review_threshold: 0.4, block_threshold: 0.8,
    categories: { violence: {}, hate: {}, harassment: {} },
  };
  const report: ModerationReport = {
    report_path: "DEMO/report.json", policy, modality: request.modality, input_hash: "demo0000",
    sampling: { interval_sec: 0.5, segment_sec: request.segment_seconds }, providers: {},
  };
  for (const provider of providers) {
    const next = random(provider === "jev" ? 11 : 29);
    const bias = provider === "jev" ? 0 : 0.06;
    const segments: ModerationRow[] = spans.map(([start, end], index) => {
      const row: ModerationRow = {
        segment_id: index + 1, start_sec: start, end_sec: end, status: "completed", action: "allow",
        elapsed_sec: Math.round((0.6 + next() * 1.8) * 1000) / 1000, visual_evidence: "sampled",
        model: provider === "jev" ? DEMO_SETTINGS.jev_model : DEMO_SETTINGS.llm_model,
      };
      if (provider === "openai" && index === 9) return { ...row, status: "failed", action: "review", error_type: "RuntimeError" };
      const mid = (start + end) / 2;
      const probabilities = Object.fromEntries(Object.keys(HOT).map(c => [c, score(c, mid, next(), bias)]));
      const peak = Math.max(...Object.values(probabilities));
      return { ...row, probabilities, action: peak >= 0.8 ? "block" : peak >= 0.4 ? "review" : "allow" };
    });
    report.providers[provider] = { complete: segments.every(r => r.status === "completed"), segments };
  }
  return report;
}

/** Emits the same event sequence as desktop.py, on a timer. Returns a cancel function. */
export function simulateRun(request: ModerationRequest, emit: (event: WorkerEvent) => void) {
  const report = demoReport(request);
  const steps: [number, WorkerEvent][] = [
    [500, { type: "moderation.progress", message: "并行处理：画面抽样与音轨转写" }],
    [2400, { type: "moderation.progress", message: "按讲话时间组合画面；补齐静音区间" }],
  ];
  let at = 3300;
  for (const [provider, result] of Object.entries(report.providers)) {
    result.segments.forEach((_, i) => {
      steps.push([at, { type: "moderation.progress", message: `${provider}: 片段 ${i + 1}/${result.segments.length}` }]);
      at += 140;
    });
  }
  steps.push([at + 300, { type: "moderation.completed", message: report.report_path, report }]);
  const timers = steps.map(([delay, event]) => window.setTimeout(() => emit(event), delay));
  return () => timers.forEach(t => window.clearTimeout(t));
}
