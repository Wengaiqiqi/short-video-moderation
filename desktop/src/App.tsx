import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import ModelSettings from "./components/ModelSettings";
import Results from "./components/Results";
import { useModeration } from "./useModeration";
import type { ModerationRequest } from "./types";

export default function App() {
  const { settings, setSettings, busy, message, report, start } = useModeration();
  const [video, setVideo] = useState("");
  const [provider, setProvider] = useState<ModerationRequest["provider"]>("both");
  const [modality, setModality] = useState<ModerationRequest["modality"]>("multimodal");
  const [key, setKey] = useState("");
  const [interval, setInterval] = useState(0.5);
  const [seconds, setSeconds] = useState(8);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  async function choose(directory = false) {
    try {
      const path = await open(directory ? { directory: true, multiple: false } : { multiple: false, filters: [{ name: "视频", extensions: ["mp4", "mkv", "mov", "webm"] }] });
      if (typeof path === "string") {
        if (directory && settings) setSettings({ ...settings, output_root: path });
        else setVideo(path);
      }
    } catch (e) { setError(String(e)); }
  }
  return <main>
    <header><p className="eyebrow">SHORT VIDEO MODERATION</p><h1>短视频内容审核</h1><p>以讲话时间组合画面，比较 Jev 与多模态模型的审核结果。</p></header>
    <form onSubmit={e => {
      e.preventDefault(); setError("");
      if (!settings || !video.trim() || !settings.output_root.trim() || !consent) { setError("请选择视频和结果目录，并确认发送内容。"); return; }
      void start({ video_path: video, output_root: settings.output_root, provider, modality, jev_key: key, interval, segment_seconds: seconds, settings, upload_consent: consent });
    }}>
      <fieldset disabled={busy || !settings}>
        <section className="card"><h2>审核任务</h2>
          <div className="path-field"><label>视频文件<input value={video} onChange={e => setVideo(e.target.value)} placeholder="选择或输入视频的完整路径" /></label><button type="button" onClick={() => { void choose(); }}>选择视频</button></div>
          <div className="path-field"><label>结果目录<input value={settings?.output_root || ""} onChange={e => settings && setSettings({ ...settings, output_root: e.target.value })} /></label><button type="button" onClick={() => { void choose(true); }}>选择目录</button></div>
          <div className="grid">
            <label>模型组<select value={provider} onChange={e => setProvider(e.target.value as typeof provider)}><option value="both">Jev ＋ 多模态对照组</option><option value="jev">仅 Jev</option><option value="openai">仅多模态对照组</option></select></label>
            <label>输入模态<select value={modality} onChange={e => setModality(e.target.value as typeof modality)}><option value="multimodal">画面 ＋ 转写</option><option value="visual">仅画面</option><option value="text">仅转写</option></select></label>
            {provider !== "openai" && <label>Jev API Key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="或设置 TYPESAFE_API_KEY 环境变量" /></label>}
          </div>
          <details><summary>抽样与时间段</summary><div className="grid"><label>定时抽帧间隔（秒）<input type="number" min={0.15} max={4} step={0.05} required value={interval} onChange={e => setInterval(Number(e.target.value))} /></label>
            <label>单段最长时长（秒）<input type="number" min={1} max={30} step={1} required value={seconds} onChange={e => setSeconds(Number(e.target.value))} /></label></div>
            <p className="muted">画面抽样和语音识别并行，场景变化时补帧；静音区间独立审核。云端无逐句时间戳时按音频块对齐，每段最多 16 帧。</p></details>
        </section>
        {settings && <ModelSettings settings={settings} onChange={setSettings} />}
        <section className="card"><label className="consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />允许将所选模态的画面/转写发送至模型服务；使用云端 ASR 时也会发送音频。</label>
          <button className="primary" type="submit">{busy ? "审核中…" : "开始审核"}</button>
          <p className="muted">当前示例规则覆盖暴力、仇恨与骚扰；最长支持 10 分钟视频。</p>
        </section>
      </fieldset>
    </form>
    <div className="status" role="status" aria-live="polite">{message}</div>
    {error && <p role="alert">{error}</p>}
    {report && <Results report={report} />}
  </main>;
}
