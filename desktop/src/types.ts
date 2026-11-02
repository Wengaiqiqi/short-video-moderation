export interface Settings {
  output_root: string;
  jev_base_url: string; jev_model: string; jev_api_key?: string;
  llm_base_url: string; llm_model: string; llm_api_key?: string;
  asr_engine: "faster-whisper" | "mimo-cloud";
  asr_model: string; asr_language: string; asr_device: string; asr_compute_type: string;
  mimo_base_url: string; mimo_model: string; asr_api_key?: string;
  /** The one global concurrency: videos at once, and the ASR / per-model request limit (default 11). */
  video_concurrency: number;
  ffmpeg_path: string; ffprobe_path: string;
  /** Reuse an identical earlier review; stop sending windows once one is blocked; split videos over 10 min. */
  skip_reviewed?: boolean; stop_on_block?: boolean; split_long_videos?: boolean;
  /** Save typed keys in the system keychain (backend only reports which keys are stored). */
  remember_keys?: boolean; keychain_available?: boolean; stored_keys?: Record<string, boolean>;
  policy?: ModerationPolicy; category_presets?: Record<string, CategoryRule>;
}
export interface CategoryRule {
  label?: string; question: string; positive: string; negative: string;
  enabled?: boolean; review_threshold?: number; block_threshold?: number;
}
export interface ModerationRow {
  segment_id: number; start_sec: number; end_sec: number;
  /** completed | failed | skipped (no evidence for this modality) */
  status: string; action: string; probabilities?: Record<string, number>;
  error_type?: string; model?: string; skip_reason?: string; usage?: Record<string, number>;
  /** "asr_failed": speech could not be transcribed, judged on frames and held for review */
  evidence?: string;
  elapsed_sec?: number; visual_evidence?: string; score_kind?: string;
}
export interface ModerationPolicy {
  version?: string;
  /** Set when thresholds were applied from the calibration dialog; cleared by manual edits. */
  calibrated_at?: string;
  review_threshold: number; block_threshold: number;
  categories: Record<string, CategoryRule>;
}
export interface ModerationReport {
  report_path: string;
  providers: Record<string, { complete: boolean; segments: ModerationRow[]; usage?: Record<string, number>; config?: { model?: string; base_url?: string } }>;
  video_path?: string; duration_sec?: number; created_at?: string; retry_of?: string;
  asr_statistics?: { chunks: number; uploaded: number; uploaded_seconds: number; skipped_silent: number; failed: number };
  frame_statistics?: { sampled: number; kept: number };
  policy?: ModerationPolicy;
  modality?: ModerationRequest["modality"];
  input_hash?: string;
  sampling?: { interval_sec?: number; segment_sec?: number };
}
export interface WorkerEvent {
  type: string; message?: string; error?: string; settings?: Settings; report?: ModerationReport;
  video_path?: string; job_id?: string; request_id?: string; cached?: boolean; duration_sec?: number;
  [key: string]: unknown;
  /** video.thumbnail */ id?: string; data_url?: string;
  /** videos.listed */ directory?: string; videos?: string[];
}
export interface ModerationRequest {
  video_path: string; output_root: string;
  provider: "both" | "jev" | "openai";
  modality: "multimodal" | "visual" | "text";
  jev_key: string; interval: number; segment_seconds: number;
  settings: Settings; upload_consent: boolean; job_id?: string;
}

/** One line in the FEED panel. Kept in memory for the current window only. */
export interface LogEntry { id: number; at: number; level: "info" | "run" | "ok" | "warn" | "error"; tag: string; text: string }

export type StageId = "engine" | "prepare" | "align" | "jev" | "openai" | "report";
export type StageState = "wait" | "run" | "pass" | "warn" | "fail" | "skip";
export interface Stage { id: StageId; state: StageState; done?: number; total?: number }

export type VideoStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export interface ReviewDecision { decision: "allow" | "block" | "review"; note?: string; at?: string }
export interface SegmentEvidence {
  segment_id: number; start_sec: number; end_sec: number; speech_text: string; audio_status?: string;
  alignment_precision?: string; frame_count: number; frames: { time_sec: number; data_url: string }[]; video_path?: string;
}
/** One video in the batch. Results live in memory for this window only. */
export interface VideoItem {
  id: string; path: string; name: string; status: VideoStatus;
  thumb?: string; report?: ModerationReport; error?: string;
  /** Whole-video verdict: the strictest across all windows and providers. */
  verdict?: "allow" | "block" | "review";
  startedAt?: number; finishedAt?: number;
  /** Reviewer's final decision; overrides the model verdict. */
  review?: ReviewDecision | null;
  /** Loaded from the results folder rather than reviewed in this window. */
  history?: boolean; cached?: boolean; duration_sec?: number;
  /** Part of a long video that was split; start/end within the original. */
  part?: { index: number; total: number; start_sec: number; end_sec: number; source: string };
}
