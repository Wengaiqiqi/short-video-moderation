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
    <div className="group"><h3><span className="swatch jev" />JEV</h3>{field("jev_base_url", "服务地址")}{field("jev_model", "模型名称")}
      <p className="hint">Jev API Key 在「任务」页填写。</p></div>
    <div className="group"><h3><span className="swatch openai" />多模态对照组</h3>{field("llm_base_url", "OpenAI 兼容服务地址")}{field("llm_model", "模型名称")}
      {field("llm_api_key", "API Key", "password", "或设置 LLM_API_KEY 环境变量")}
      <p className="hint">默认对照模型只是示例，请填写实际使用的模型名称及地址。</p></div>
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
      <p className="hint">本地模型首次使用时会下载权重。时间戳取识别片段。</p>
    </> : <>
      {field("mimo_base_url", "ASR 服务地址")}{field("mimo_model", "ASR 模型名称")}
      {field("asr_api_key", "ASR API Key", "password", "或设置 MIMO_API_KEY 环境变量")}{field("asr_concurrency", "并发请求数（1–10）", "number")}
      <p className="hint warn">云端 ASR 没有逐句时间戳，按 30 秒音频块对齐，窗口边界精度较低；音频会发送至该服务。</p>
    </>}
  </div>;
  return <div className="group">
    <h3>FFmpeg</h3>
    {field("ffmpeg_path", "ffmpeg 可执行文件", "text", "已加入 PATH 时留空")}{field("ffprobe_path", "ffprobe 可执行文件", "text", "已加入 PATH 时留空")}
    <p className="hint">API Key 只保存在当前窗口内存中，不写入设置或报告；也可使用 TYPESAFE_API_KEY、LLM_API_KEY、MIMO_API_KEY 环境变量。</p>
  </div>;
}
