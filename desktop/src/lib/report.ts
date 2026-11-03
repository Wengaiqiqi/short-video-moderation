import type { ModerationReport, ModerationRow, TranscriptJudgement } from "../types";

/** The three bins of the flow map. Failed segments always land in "review" (待定 / 人工复核). */
export type Verdict = "allow" | "block" | "review";
export const VERDICTS: { id: Verdict; zh: string; en: string }[] = [
  { id: "allow", zh: "通过", en: "ALLOW" },
  { id: "block", zh: "拦截", en: "BLOCK" },
  { id: "review", zh: "待定", en: "REVIEW" },
];
const SEVERITY: Record<Verdict, number> = { allow: 0, review: 1, block: 2 };

export type ProviderFilter = "all" | string;
export const PROVIDER_ORDER = ["jev", "openai"];
export const PROVIDER_LABEL: Record<string, string> = { jev: "JEV", openai: "对照组" };
export const CATEGORY_LABEL: Record<string, string> = { violence: "暴力", hate: "仇恨", harassment: "骚扰" };
export const DEFAULT_CATEGORIES = ["violence", "hate", "harassment"];

export function providerLabel(id: string) { return PROVIDER_LABEL[id] ?? id.toUpperCase(); }
/** Chinese name from the report's policy when present, else the built-in names. */
export function categoryLabel(id: string, report?: ModerationReport | null) {
  return report?.policy?.categories?.[id]?.label ?? CATEGORY_LABEL[id] ?? id;
}

export function verdictOf(row: Pick<ModerationRow, "status" | "action">): Verdict {
  if (row.status === "skipped") return "allow";
  if (row.status !== "completed") return "review";
  return row.action === "block" ? "block" : row.action === "allow" ? "allow" : "review";
}
export function isFailed(row?: ModerationRow) { return !!row && row.status !== "completed" && row.status !== "skipped"; }
export function isSkipped(row?: ModerationRow) { return !!row && row.status === "skipped"; }
const ERROR_TEXT: Record<string, string> = {
  http_401: "鉴权失败（401）", http_403: "无权限（403）", http_404: "地址或模型不存在（404）", http_429: "请求过于频繁（429）",
  timeout: "请求超时", network: "网络错误", invalid_json: "响应格式错误", retries_exhausted: "重试后仍失败", asr_failed: "语音识别失败",
};
export function errorText(code?: string) {
  if (!code) return "未知错误";
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  const http = /^http_(\d+)$/.exec(code);
  return http ? `服务错误（${http[1]}）` : code;
}
export function peakOf(row?: ModerationRow) {
  const values = Object.values(row?.probabilities ?? {});
  return values.length ? Math.max(...values) : 0;
}

export function thresholds(report?: ModerationReport | null, category?: string) {
  const rule = category ? report?.policy?.categories?.[category] : undefined;
  return { review: rule?.review_threshold ?? report?.policy?.review_threshold ?? 0.65,
           block: rule?.block_threshold ?? report?.policy?.block_threshold ?? 0.8 };
}
export function categoriesOf(report?: ModerationReport | null) {
  const fromPolicy = Object.keys(report?.policy?.categories ?? {});
  if (fromPolicy.length) return fromPolicy;
  for (const result of Object.values(report?.providers ?? {})) {
    const row = result.segments.find(r => r.probabilities);
    if (row?.probabilities) return Object.keys(row.probabilities);
  }
  return DEFAULT_CATEGORIES;
}
export function providersOf(report?: ModerationReport | null) {
  const ids = Object.keys(report?.providers ?? {});
  return [...PROVIDER_ORDER.filter(id => ids.includes(id)), ...ids.filter(id => !PROVIDER_ORDER.includes(id))];
}
export function visibleProviders(report: ModerationReport | null | undefined, filter: ProviderFilter) {
  const all = providersOf(report);
  return filter === "all" || !all.includes(filter) ? all : [filter];
}

/** One time window with the judgements of every provider for that window. */
export interface SegmentView {
  id: number; start: number; end: number;
  rows: Record<string, ModerationRow>;
  /** Most severe verdict among the visible providers. */
  verdict: Verdict; failed: boolean; peak: number;
}

export function segmentsOf(report: ModerationReport | null | undefined, providers: string[]): SegmentView[] {
  const byId = new Map<number, SegmentView>();
  for (const provider of providers) {
    for (const row of report?.providers[provider]?.segments ?? []) {
      let view = byId.get(row.segment_id);
      if (!view) {
        view = { id: row.segment_id, start: row.start_sec, end: row.end_sec, rows: {}, verdict: "allow", failed: false, peak: 0 };
        byId.set(row.segment_id, view);
      }
      view.rows[provider] = row;
      const verdict = verdictOf(row);
      if (SEVERITY[verdict] > SEVERITY[view.verdict]) view.verdict = verdict;
      view.failed ||= isFailed(row);
      view.peak = Math.max(view.peak, peakOf(row));
    }
  }
  return [...byId.values()].sort((a, b) => a.start - b.start || a.id - b.id);
}

export interface Tally { allow: number; block: number; review: number; failed: number }
export function tally(report: ModerationReport | null | undefined, providers: string[]): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const provider of providers) {
    const t: Tally = { allow: 0, block: 0, review: 0, failed: 0 };
    for (const row of report?.providers[provider]?.segments ?? []) {
      t[verdictOf(row)] += 1;
      if (isFailed(row)) t.failed += 1;
    }
    out[provider] = t;
  }
  return out;
}

/** Share of windows where both providers reach the same verdict; null without two complete sides. */
export function agreement(report: ModerationReport | null | undefined) {
  const [a, b] = providersOf(report);
  if (!a || !b || !report) return null;
  const other = new Map(report.providers[b].segments.map(r => [r.segment_id, r]));
  let same = 0, total = 0;
  for (const row of report.providers[a].segments) {
    const peer = other.get(row.segment_id);
    if (!peer || isFailed(row) || isFailed(peer)) continue;
    total += 1;
    if (verdictOf(row) === verdictOf(peer)) same += 1;
  }
  return total ? same / total : null;
}

export function fmtTime(seconds: number, precise = true) {
  const s = Math.max(0, seconds);
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  const sec = precise ? rest.toFixed(1).padStart(4, "0") : String(Math.floor(rest)).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${sec}`;
}
export function fmtClock(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}
export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
export function pad2(n: number) { return String(n).padStart(2, "0"); }

/** Strictest verdict over every window of every provider; nothing judged at all → review. */
export function windowVerdict(report: ModerationReport | null | undefined): Verdict {
  let verdict: Verdict = "allow";
  let rows = 0;
  for (const result of Object.values(report?.providers ?? {})) {
    for (const row of result.segments) {
      if (row.status !== "skipped") rows += 1;
      const v = verdictOf(row);
      if (SEVERITY[v] > SEVERITY[verdict]) verdict = v;
    }
  }
  return rows ? verdict : "review";
}

/** Whole-transcript judgements of the given providers (all when omitted). */
export function transcriptsOf(report: ModerationReport | null | undefined, providers?: string[]) {
  const out: [string, TranscriptJudgement][] = [];
  for (const provider of providers ?? providersOf(report)) {
    const text = report?.providers[provider]?.transcript;
    if (text) out.push([provider, text]);
  }
  return out;
}
/** Strictest whole-transcript verdict, or null when the run had none. */
export function transcriptVerdict(report: ModerationReport | null | undefined): Verdict | null {
  const texts = transcriptsOf(report);
  if (!texts.length) return null;
  return texts.map(([, t]) => verdictOf(t)).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "allow" as Verdict);
}

/**
 * Whole-video verdict. Windows: strictest wins (any block → block; any review or failure → review).
 * The whole-transcript judgement joins strictest-wins, except that when it alone finds a problem
 * (every window passed) the video is held for review rather than blocked: see semanticOnly.
 */
export function videoVerdict(report: ModerationReport | null | undefined): Verdict {
  const windows = windowVerdict(report);
  const text = transcriptVerdict(report);
  if (!text || text === "allow") return windows;
  if (windows === "allow") return "review";
  return SEVERITY[text] > SEVERITY[windows] ? text : windows;
}
/** Only the whole-transcript judgement found a problem (shown as 「全文语义」). */
export function semanticOnly(report: ModerationReport | null | undefined) {
  const text = transcriptVerdict(report);
  return !!text && text !== "allow" && windowVerdict(report) === "allow";
}
/** Windows holding sentences that the whole-transcript judgement named, per window the categories. */
export function semanticWindows(report: ModerationReport | null | undefined, providers?: string[]) {
  const out = new Map<number, Set<string>>();
  const byId = new Map((report?.transcript ?? []).map(s => [s.id, s]));
  for (const [, text] of transcriptsOf(report, providers)) {
    if (text.status !== "completed") continue;
    for (const [category, ids] of Object.entries(text.sentences ?? {})) {
      for (const id of ids) for (const window of byId.get(id)?.segments ?? []) {
        if (!out.has(window)) out.set(window, new Set());
        out.get(window)!.add(category);
      }
    }
  }
  return out;
}
/** Sentence id → categories named for it by the given providers' whole-transcript judgements. */
export function flaggedSentences(report: ModerationReport | null | undefined, providers?: string[]) {
  const out = new Map<number, Set<string>>();
  for (const [, text] of transcriptsOf(report, providers)) {
    if (text.status !== "completed") continue;
    for (const [category, ids] of Object.entries(text.sentences ?? {})) for (const id of ids) {
      if (!out.has(id)) out.set(id, new Set());
      out.get(id)!.add(category);
    }
  }
  return out;
}
export function transcriptFailures(report: ModerationReport | null | undefined) {
  return transcriptsOf(report).filter(([, t]) => t.status === "failed").length;
}
export const VERDICT_ZH: Record<Verdict, string> = { allow: "通过", block: "拦截", review: "待定" };

/** Rough share of one video's run, from the stage list (prepare → align → providers). */
export function stageProgress(stages: Record<string, { state: string; done?: number; total?: number }>) {
  const providers = (["jev", "openai"] as const).filter(id => stages[id] && stages[id].state !== "skip");
  const asr = stages.prepare?.total ? (stages.prepare.done ?? 0) / stages.prepare.total : 0;
  let value = stages.prepare?.state === "run" ? 0.04 + 0.18 * asr : stages.prepare?.state === "pass" ? 0.24 : 0.02;
  if (stages.align?.state === "pass") value = 0.3;
  for (const id of providers) {
    const stage = stages[id];
    const share = stage.state === "pass" || stage.state === "warn" ? 1 : stage.total ? (stage.done ?? 0) / stage.total : 0;
    value += (0.68 / providers.length) * share;
  }
  return Math.min(0.99, value);
}

/** Where one video is in the pipeline, for the flow map. */
export type Phase = "queued" | "prepare" | "align" | "classify" | "done";
export function phaseOf(stages?: Record<string, { state: string }>): Phase {
  if (!stages) return "queued";
  if (stages.jev?.state === "run" || stages.openai?.state === "run") return "classify";
  if (stages.align?.state === "run") return "align";
  if (stages.align?.state === "pass") return "classify";
  if (stages.prepare?.state === "run") return "prepare";
  return "queued";
}

/** The verdict that counts: the reviewer's final decision when there is one, else the model verdict. */
export function finalVerdict(video: { verdict?: Verdict; review?: { decision: Verdict } | null }): Verdict | undefined {
  return video.review?.decision ?? video.verdict;
}

/** Windows where both provider groups reached a (completed) verdict and the verdicts differ. */
export function disagreements(report: ModerationReport | null | undefined): Set<number> {
  const out = new Set<number>();
  const [a, b] = providersOf(report);
  if (!a || !b || !report) return out;
  const other = new Map(report.providers[b].segments.map(r => [r.segment_id, r]));
  for (const row of report.providers[a].segments) {
    const peer = other.get(row.segment_id);
    if (peer && row.status === "completed" && peer.status === "completed" && verdictOf(row) !== verdictOf(peer)) out.add(row.segment_id);
  }
  return out;
}

/** Total tokens of one provider's usage counters, whatever the field names. */
export function tokensOf(usage?: Record<string, number>) {
  if (!usage) return 0;
  if (usage.total_tokens) return usage.total_tokens;
  return (usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? 0);
}

export interface Cost { tokens: Record<string, number>; asrSeconds: number }
/** Tokens per provider and uploaded ASR seconds of one report. */
export function costOf(report: ModerationReport | null | undefined): Cost {
  const tokens: Record<string, number> = {};
  for (const [provider, data] of Object.entries(report?.providers ?? {})) {
    tokens[provider] = tokensOf(data.usage)
      || data.segments.reduce((a, r) => a + tokensOf(r.usage), 0) + tokensOf(data.transcript?.usage);
  }
  return { tokens, asrSeconds: report?.asr_statistics?.uploaded_seconds ?? 0 };
}
export function fmtTokens(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}
