import { useState } from "react";
import ModelSettings from "./ModelSettings";
import Segmented from "./Segmented";
import type { ModerationRequest, Settings } from "../types";

export interface TaskForm {
  video: string; provider: ModerationRequest["provider"]; modality: ModerationRequest["modality"];
  key: string; interval: number; seconds: number; consent: boolean;
}
type Tab = "task" | "models" | "asr" | "system";
const TABS: { id: Tab; en: string; zh: string }[] = [
  { id: "task", en: "TASK", zh: "任务" }, { id: "models", en: "MODELS", zh: "模型" },
  { id: "asr", en: "ASR", zh: "语音" }, { id: "system", en: "SYS", zh: "系统" },
];

interface Props {
  form: TaskForm; update: (patch: Partial<TaskForm>) => void;
  settings: Settings | null; setSettings: (settings: Settings) => void;
  busy: boolean; error: string; preview: boolean;
  collapsed: boolean; onCollapse: (collapsed: boolean) => void;
  onBrowse: (directory: boolean) => void; onSubmit: () => void;
}

export default function TaskPanel({ form, update, settings, setSettings, busy, error, preview, collapsed, onCollapse, onBrowse, onSubmit }: Props) {
  const [tab, setTab] = useState<Tab>("task");
  if (collapsed) {
    return <aside className="panel task-rail">
      <button type="button" className="rail-button" onClick={() => onCollapse(false)} aria-label="展开任务配置" title="展开任务配置">»</button>
      <span className="rail-text">TASK · 任务配置</span>
    </aside>;
  }
  return <aside className="panel task-panel">
    <header className="panel-head">
      <span><b>TASK</b> · 审核任务</span>
      <button type="button" className="icon-button" onClick={() => onCollapse(true)} aria-label="收起任务配置" title="收起">«</button>
    </header>
    <div className="tabs" role="tablist" aria-label="配置分组">
      {TABS.map(t => <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="task-tabpanel"
        className={tab === t.id ? "on" : undefined} onClick={() => setTab(t.id)}><b>{t.en}</b>{t.zh}</button>)}
    </div>
    <form className="task-form" onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      <fieldset className="task-scroll" disabled={busy || !settings} id="task-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "task" && <>
          <div className="group">
            <div className="path-field"><label className="field">视频文件<input value={form.video} spellCheck={false} onChange={e => update({ video: e.target.value })} placeholder="选择或输入视频完整路径" /></label>
              <button type="button" onClick={() => onBrowse(false)}>浏览</button></div>
            <div className="path-field"><label className="field">结果目录<input value={settings?.output_root ?? ""} spellCheck={false} onChange={e => settings && setSettings({ ...settings, output_root: e.target.value })} /></label>
              <button type="button" onClick={() => onBrowse(true)}>浏览</button></div>
          </div>
          <div className="group">
            <Segmented legend="模型组" name="provider" value={form.provider} onChange={provider => update({ provider })}
              options={[{ value: "both", label: "JEV ＋ 对照" }, { value: "jev", label: "仅 JEV" }, { value: "openai", label: "仅对照" }]} />
            <Segmented legend="输入模态" name="modality" value={form.modality} onChange={modality => update({ modality })}
              options={[{ value: "multimodal", label: "画面＋转写" }, { value: "visual", label: "仅画面" }, { value: "text", label: "仅转写" }]} />
            {form.provider !== "openai" && <label className="field">JEV API Key<input type="password" autoComplete="off" value={form.key}
              onChange={e => update({ key: e.target.value })} placeholder="或设置 TYPESAFE_API_KEY 环境变量" /></label>}
          </div>
          <div className="group">
            <h3>抽样与窗口</h3>
            <div className="pair">
              <label className="field">定时抽帧（秒）<input type="number" min={0.15} max={4} step={0.05} required value={form.interval} onChange={e => update({ interval: Number(e.target.value) })} /></label>
              <label className="field">单段最长（秒）<input type="number" min={1} max={30} step={1} required value={form.seconds} onChange={e => update({ seconds: Number(e.target.value) })} /></label>
            </div>
            <p className="hint">画面抽样与语音识别并行，场景变化时补帧；静音区间独立审核。每段最多 16 帧，最长支持 10 分钟视频。</p>
          </div>
        </>}
        {tab !== "task" && settings && <ModelSettings section={tab} settings={settings} onChange={setSettings} />}
      </fieldset>
      <div className="task-foot">
        <label className="consent"><input type="checkbox" checked={form.consent} disabled={busy} onChange={e => update({ consent: e.target.checked })} />
          <span>允许将所选模态的画面/转写发送至模型服务；使用云端 ASR 时也会发送音频。</span></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy || !settings}>{busy ? "审核中…" : preview ? "运行 DEMO 预览" : "开始审核"}</button>
        <p className="hint">示例规则覆盖暴力、仇恨与骚扰。</p>
      </div>
    </form>
  </aside>;
}
