import { useState } from "react";
import ModelSettings from "./ModelSettings";
import RulesEditor from "./RulesEditor";
import Segmented from "./Segmented";
import type { ModerationRequest, Settings, VideoItem } from "../types";

export interface TaskForm {
  provider: ModerationRequest["provider"]; modality: ModerationRequest["modality"];
  interval: number; seconds: number;
}
type Tab = "task" | "rules" | "models" | "asr" | "system";
const TABS: { id: Tab; en: string; zh: string }[] = [
  { id: "task", en: "TASK", zh: "任务" }, { id: "rules", en: "RULES", zh: "规则" }, { id: "models", en: "MODELS", zh: "模型" },
  { id: "asr", en: "ASR", zh: "语音" }, { id: "system", en: "SYS", zh: "系统" },
];
const STATUS: Record<VideoItem["status"], string> = { queued: "排队", running: "审核中", done: "完成", failed: "失败", cancelled: "已取消" };

interface Props {
  form: TaskForm; update: (patch: Partial<TaskForm>) => void;
  settings: Settings | null; setSettings: (settings: Settings) => void;
  videos: VideoItem[]; queueActive: boolean; busy: boolean; error: string; preview: boolean;
  collapsed: boolean; onCollapse: (collapsed: boolean) => void;
  onAddFiles: () => void; onAddFolder: () => void; onAddPath: (path: string) => void; onBrowseOutput: () => void;
  onRemove: (id: string) => void; onClearQueued: () => void;
  onStart: () => void; onStop: () => void; running: number; limit: number;
  onCancel: (id: string) => void; onCancelAll: () => void; onRequeue: (id: string) => void;
}

function Toggle({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <label className="switch-field" title={title}><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span className="toggle" aria-hidden="true" />{label}</label>;
}

export default function TaskPanel(props: Props) {
  const { form, update, settings, setSettings, videos, queueActive, busy, error, preview, collapsed, onCollapse } = props;
  const [tab, setTab] = useState<Tab>("task");
  const [path, setPath] = useState("");
  const pending = videos.filter(v => v.status === "queued" || v.status === "running" || v.status === "cancelled");
  const queued = pending.filter(v => v.status === "queued").length;
  const finished = videos.length - pending.length;
  const locked = queueActive || busy || !settings;

  if (collapsed) {
    return <aside className="panel task-rail">
      <button type="button" className="rail-button" onClick={() => onCollapse(false)} aria-label="展开任务配置" title="展开任务配置">»</button>
      <span className="rail-text">TASK · 任务配置 · 排队 {queued}</span>
    </aside>;
  }
  return <aside className="panel task-panel">
    <header className="panel-head">
      <span><b>TASK</b></span>
      <button type="button" className="icon-button" onClick={() => onCollapse(true)} aria-label="收起任务配置" title="收起">«</button>
    </header>
    <div className="tabs" role="tablist" aria-label="配置分组">
      {TABS.map(t => <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="task-tabpanel"
        className={tab === t.id ? "on" : undefined} onClick={() => setTab(t.id)}><b>{t.en}</b>{t.zh}</button>)}
    </div>
    <form className="task-form" onSubmit={e => { e.preventDefault(); if (queueActive) props.onStop(); else props.onStart(); }}>
      <div className="task-scroll" id="task-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "task" && <>
          {/* The queue stays editable while a batch runs */}
          <div className="group">
            <h3>视频队列<span className="h-meta">排队 {queued} · 已完成 {finished}</span></h3>
            <div className="btn-row">
              <button type="button" onClick={props.onAddFiles} disabled={!settings}>＋ 添加视频</button>
              <button type="button" onClick={props.onAddFolder} disabled={!settings}>＋ 整个文件夹</button>
            </div>
            <div className="path-field compact">
              <input aria-label="视频路径" value={path} spellCheck={false} placeholder={preview ? "DEMO：用上方按钮添加" : "粘贴视频路径"}
                onChange={e => setPath(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (path.trim()) { props.onAddPath(path); setPath(""); } } }} />
              <button type="button" disabled={!path.trim()} onClick={() => { props.onAddPath(path); setPath(""); }}>加入</button>
            </div>
            {pending.length > 0 && <ol className="queue">
              {pending.map(v => <li key={v.id} className={`q-${v.status}`}>
                <span className="q-thumb">{v.thumb ? <img src={v.thumb} alt="" /> : null}</span>
                <span className="q-name" title={v.path}>{v.name}</span>
                <span className="q-state">{STATUS[v.status]}</span>
                {v.status === "queued" && <button type="button" className="q-remove" aria-label={`移出队列：${v.name}`} title="移出队列" onClick={() => props.onRemove(v.id)}>×</button>}
                {v.status === "running" && <button type="button" className="q-remove" aria-label={`取消：${v.name}`} title="立即取消" onClick={() => props.onCancel(v.id)}>■</button>}
                {v.status === "cancelled" && <button type="button" className="q-remove" aria-label={`重新排队：${v.name}`} title="重新排队" onClick={() => props.onRequeue(v.id)}>↻</button>}
              </li>)}
            </ol>}
            {queued > 1 && <button type="button" className="link-button" onClick={props.onClearQueued}>清空排队</button>}
            {/* Can be changed while the queue runs; takes effect as videos finish */}
            {settings && <label className="field inline-field">并发视频
              <span className="stepper">
                <button type="button" aria-label="减少并发" onClick={() => setSettings({ ...settings, video_concurrency: Math.max(1, (settings.video_concurrency ?? 11) - 1) })}>−</button>
                <input type="number" min={1} max={32} step={1} value={settings.video_concurrency ?? 11}
                  onChange={e => setSettings({ ...settings, video_concurrency: Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 1))) })} />
                <button type="button" aria-label="增加并发" onClick={() => setSettings({ ...settings, video_concurrency: Math.min(32, (settings.video_concurrency ?? 11) + 1) })}>＋</button>
              </span>
              <span className="h-meta">进行中 {props.running}/{props.limit}</span></label>}
            {settings && <div className="toggles">
              <Toggle label="跳过已审过的视频" checked={settings.skip_reviewed !== false} title="同一文件、同样配置已有完整结果时直接复用"
                onChange={v => setSettings({ ...settings, skip_reviewed: v })} />
              <Toggle label="命中拦截即停止送审" checked={!!settings.stop_on_block} title="一段被拦截后，剩余片段不再送审（报告会不完整）"
                onChange={v => setSettings({ ...settings, stop_on_block: v })} />
              <Toggle label="自动切分超过 10 分钟的视频" checked={settings.split_long_videos !== false}
                onChange={v => setSettings({ ...settings, split_long_videos: v })} />
            </div>}
          </div>
          <fieldset className="plain" disabled={locked}>
            <div className="group">
              <div className="path-field"><label className="field">结果目录<input value={settings?.output_root ?? ""} spellCheck={false} onChange={e => settings && setSettings({ ...settings, output_root: e.target.value })} /></label>
                <button type="button" onClick={props.onBrowseOutput}>浏览</button></div>
              <Segmented legend="模型组" name="provider" value={form.provider} onChange={provider => update({ provider })}
                options={[{ value: "both", label: "JEV ＋ 对照" }, { value: "jev", label: "仅 JEV" }, { value: "openai", label: "仅对照" }]} />
              <Segmented legend="输入模态" name="modality" value={form.modality} onChange={modality => update({ modality })}
                options={[{ value: "multimodal", label: "画面＋转写" }, { value: "visual", label: "仅画面" }, { value: "text", label: "仅转写" }]} />
            </div>
            <div className="group">
              <h3>抽样与窗口</h3>
              <div className="pair">
                <label className="field">定时抽帧（秒）<input type="number" min={0.15} max={4} step={0.05} required value={form.interval} onChange={e => update({ interval: Number(e.target.value) })} /></label>
                <label className="field">单段最长（秒）<input type="number" min={1} max={30} step={1} required value={form.seconds} onChange={e => update({ seconds: Number(e.target.value) })} /></label>
              </div>
            </div>
          </fieldset>
        </>}
        {tab === "rules" && settings && <fieldset className="plain" disabled={locked}><RulesEditor settings={settings} onChange={setSettings} /></fieldset>}
        {(tab === "models" || tab === "asr" || tab === "system") && settings &&
          <fieldset className="plain" disabled={locked}><ModelSettings section={tab} settings={settings} onChange={setSettings} /></fieldset>}
      </div>
      <div className="task-foot">
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="foot-row">
          <button className={`primary${queueActive ? " stop" : ""}`} type="submit" disabled={!settings || (!queueActive && queued === 0)}>
            {queueActive ? "暂停队列" : `${preview ? "运行 DEMO" : "开始审核"} · ${queued} 个视频`}
          </button>
          {props.running > 0 && <button type="button" className="primary danger" onClick={props.onCancelAll} title="暂停队列并立即取消所有进行中的视频">全部停止</button>}
        </div>
      </div>
    </form>
  </aside>;
}
