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
}
export interface ModerationReport {
  report_path: string;
  providers: Record<string, { complete: boolean; segments: ModerationRow[] }>;
}
export interface WorkerEvent {
  type: string; message?: string; error?: string; settings?: Settings; report?: ModerationReport;
}
export interface ModerationRequest {
  video_path: string; output_root: string;
  provider: "both" | "jev" | "openai";
  modality: "multimodal" | "visual" | "text";
  jev_key: string; interval: number; segment_seconds: number;
  settings: Settings; upload_consent: boolean;
}
