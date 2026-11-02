import type { Settings } from "../types";

export default function ModelSettings({ settings, onChange }: { settings: Settings; onChange: (settings: Settings) => void }) {
  function field(key: keyof Settings, label: string, type = "text") {
    return <label>{label}<input type={type} autoComplete="off" value={settings[key] ?? ""}
      onChange={e => onChange({ ...settings, [key]: type === "number" ? Number(e.target.value) : e.target.value })} /></label>;
  }
  return <details className="card settings" open>
    <summary>模型与语音识别设置</summary>
    <div className="grid">
      <section><h3>Jev</h3>{field("jev_base_url", "服务地址")}{field("jev_model", "模型名称")}</section>
      <section><h3>多模态对照组</h3>{field("llm_base_url", "OpenAI 兼容服务地址")}{field("llm_model", "模型名称")}{field("llm_api_key", "API Key", "password")}</section>
      <section><h3>语音识别</h3>
        <label>引擎<select value={settings.asr_engine} onChange={e => onChange({ ...settings, asr_engine: e.target.value as Settings["asr_engine"] })}>
          <option value="faster-whisper">本地 faster-whisper</option><option value="mimo-cloud">MiMo 云端 ASR</option>
        </select></label>
        {settings.asr_engine === "faster-whisper" ? <>
          {field("asr_model", "模型名称或本地模型目录")}{field("asr_language", "语言代码（留空自动识别）")}
          <label>运行设备<select value={settings.asr_device} onChange={e => onChange({ ...settings, asr_device: e.target.value })}><option value="cpu">CPU</option><option value="cuda">CUDA</option><option value="auto">自动</option></select></label>
          {field("asr_compute_type", "计算精度（CPU 默认 int8）")}
        </> : <>{field("mimo_base_url", "ASR 服务地址")}{field("mimo_model", "ASR 模型名称")}{field("asr_api_key", "ASR API Key", "password")}{field("asr_concurrency", "并发请求数（1–10）", "number")}</>}
      </section>
    </div>
    <details><summary>FFmpeg 路径（已加入 PATH 时留空）</summary><div className="grid">{field("ffmpeg_path", "ffmpeg 可执行文件")}{field("ffprobe_path", "ffprobe 可执行文件")}</div></details>
    <p className="muted">API Key 仅保存在本次窗口内，也可通过环境变量配置。本地模型首次使用时会下载权重。</p>
  </details>;
}
