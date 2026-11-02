import Segmented from "./Segmented";
import type { Settings } from "../types";

type Section = "models" | "asr" | "system";

/** Model, ASR and system settings. Keys stay in memory for this window only. */
export default function ModelSettings({ section, settings, onChange }: { section: Section; settings: Settings; onChange: (settings: Settings) => void }) {
  function field(key: keyof Settings, label: string, type = "text", placeholder?: string) {
    return <label className="field">{label}<input type={type} autoComplete="off" spellCheck={false} placeholder={placeholder} value={settings[key] ?? ""}
      onChange={e => onChange({ ...settings, [key]: type === "number" ? Number(e.target.value) : e.target.value })} /></label>;
  }
  if (section === "models") return <>
    <div className="group"><h3><span className="swatch jev" />JEV</h3>{field("jev_base_url", "服务地址")}{field("jev_model", "模型名称")}</div>
    <div className="group"><h3><span className="swatch openai" />多模态对照组</h3>{field("llm_base_url", "OpenAI 兼容服务地址")}{field("llm_model", "模型名称")}
      {field("llm_api_key", "API Key", "password", "或 LLM_API_KEY")}</div>
    <div className="group"><h3>请求并发</h3>{field("model_concurrency", "每组同时请求数（全局）", "number")}</div>
  </>;
  if (section === "asr") return <div className="group">
    <Segmented legend="识别引擎" name="asr-engine" value={settings.asr_engine} onChange={asr_engine => onChange({ ...settings, asr_engine })}
      options={[{ value: "faster-whisper", label: "本地 faster-whisper" }, { value: "mimo-cloud", label: "MiMo 云端" }]} />
    {settings.asr_engine === "faster-whisper" ? <>
      {field("asr_model", "模型名称或本地模型目录")}
      {field("asr_language", "语言代码", "text", "留空自动识别")}
      <label className="field">运行设备<select value={settings.asr_device} onChange={e => onChange({ ...settings, asr_device: e.target.value })}>
        <option value="cpu">CPU</option><option value="cuda">CUDA</option><option value="auto">自动</option></select></label>
      {field("asr_compute_type", "计算精度", "text", "CPU 默认 int8")}
    </> : <>
      {field("mimo_base_url", "ASR 服务地址")}{field("mimo_model", "ASR 模型名称")}
      {field("asr_api_key", "ASR API Key", "password", "或 MIMO_API_KEY")}{field("asr_concurrency", "同时请求数（全局，1–10）", "number")}
      <p className="hint warn">音频将上传；时间精度为语音段级</p>
    </>}
  </div>;
  return <div className="group">
    <h3>FFmpeg</h3>
    {field("ffmpeg_path", "ffmpeg", "text", "PATH")}{field("ffprobe_path", "ffprobe", "text", "PATH")}
    <p className="hint">API Key 仅保存在本窗口内存</p>
  </div>;
}
