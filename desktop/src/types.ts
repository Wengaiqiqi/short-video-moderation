export interface Settings {
  output_root: string;
  jev_base_url: string; jev_model: string;
  llm_base_url: string; llm_model: string; llm_api_key?: string;
  asr_engine: "faster-whisper" | "mimo-cloud";
  asr_model: string; asr_language: string; asr_device: string; asr_compute_type: string;
  mimo_base_url: string; mimo_model: string; asr_api_key?: string; asr_concurrency: number;
  ffmpeg_path: string; ffprobe_path: string;
}
export interface ModerationRow {
  segment_id: number; start_sec: number; end_sec: number;
  status: string; action: string; probabilities?: Record<string, number>;
  error_type?: string; model?: string;
  elapsed_sec?: number; visual_evidence?: string; score_kind?: string;
}
export interface ModerationPolicy {
  version?: string;
  review_threshold: number; block_threshold: number;
  categories: Record<string, unknown>;
}
export interface ModerationReport {
  report_path: string;
  providers: Record<string, { complete: boolean; segments: ModerationRow[]; config?: { model?: string; base_url?: string } }>;
  policy?: ModerationPolicy;
  modality?: ModerationRequest["modality"];
  input_hash?: string;
  sampling?: { interval_sec?: number; segment_sec?: number };
}
export interface WorkerEvent {
  type: string; message?: string; error?: string; settings?: Settings; report?: ModerationReport;
  video_path?: string;
  /** video.thumbnail */ id?: string; data_url?: string;
  /** videos.listed */ directory?: string; videos?: string[];
}
export interface ModerationRequest {
  video_path: string; output_root: string;
  provider: "both" | "jev" | "openai";
  modality: "multimodal" | "visual" | "text";
  jev_key: string; interval: number; segment_seconds: number;
  settings: Settings; upload_consent: boolean;
}

/** One line in the FEED panel. Kept in memory for the current window only. */
export interface LogEntry { id: number; at: number; level: "info" | "run" | "ok" | "warn" | "error"; tag: string; text: string }

export type StageId = "engine" | "prepare" | "align" | "jev" | "openai" | "report";
export type StageState = "wait" | "run" | "pass" | "warn" | "fail" | "skip";
export interface Stage { id: StageId; state: StageState; done?: number; total?: number }

export type VideoStatus = "queued" | "running" | "done" | "failed";
/** One video in the batch. Results live in memory for this window only. */
export interface VideoItem {
  id: string; path: string; name: string; status: VideoStatus;
  thumb?: string; report?: ModerationReport; error?: string;
  /** Whole-video verdict: the strictest across all windows and providers. */
  verdict?: "allow" | "block" | "review";
  startedAt?: number; finishedAt?: number;
}
