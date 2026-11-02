import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Detail from "./components/Detail";
import Feed from "./components/Feed";
import FlowMap from "./components/FlowMap";
import Pipeline from "./components/Pipeline";
import Results from "./components/Results";
import TaskPanel, { type TaskForm } from "./components/TaskPanel";
import TopBar from "./components/TopBar";
import { DEMO_VIDEO } from "./demo";
import { segmentsOf, visibleProviders, type ProviderFilter } from "./lib/report";
import { useModeration } from "./useModeration";
import type { Stage, StageId } from "./types";

/** Rough share of the whole run, for the hairline under the top bar. */
function progressOf(stages: Record<StageId, Stage>, busy: boolean, finished: boolean) {
  if (finished) return 1;
  if (!busy) return 0;
  const providers = (["jev", "openai"] as const).filter(id => stages[id].state !== "skip");
  let value = stages.prepare.state === "run" ? 0.08 : stages.prepare.state === "pass" ? 0.24 : 0.02;
  if (stages.align.state === "pass") value = 0.3;
  for (const id of providers) {
    const stage = stages[id];
    const share = stage.state === "pass" || stage.state === "warn" ? 1 : stage.total ? (stage.done ?? 0) / stage.total : 0;
    value += (0.68 / providers.length) * share;
  }
  return Math.min(0.99, value);
}

export default function App() {
  const { preview, settings, setSettings, busy, engine, message, report, log, stages, run, start } = useModeration();
  const [form, setForm] = useState<TaskForm>({ video: "", provider: "both", modality: "multimodal", key: "", interval: 0.5, seconds: 8, consent: false });
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [selected, setSelected] = useState<number | null>(null);
  const update = (patch: Partial<TaskForm>) => setForm(f => ({ ...f, ...patch }));

  const providers = useMemo(() => visibleProviders(report, filter), [report, filter]);
  const segments = useMemo(() => segmentsOf(report, providers), [report, providers]);
  const segment = segments.find(s => s.id === selected) ?? null;
  const cloudAsr = (run?.asrEngine ?? settings?.asr_engine) === "mimo-cloud";

  async function browse(directory: boolean) {
    if (preview) { if (!directory) update({ video: DEMO_VIDEO }); return; }
    try {
      const path = await open(directory ? { directory: true, multiple: false } : { multiple: false, filters: [{ name: "视频", extensions: ["mp4", "mkv", "mov", "webm"] }] });
      if (typeof path === "string") {
        if (directory && settings) setSettings({ ...settings, output_root: path });
        else update({ video: path });
      }
    } catch (e) { setError(String(e)); }
  }

  function submit() {
    setError("");
    if (!settings || !form.video.trim() || !settings.output_root.trim() || !form.consent) {
      setError("请选择视频和结果目录，并确认发送内容。");
      return;
    }
    setSelected(null); setFilter("all");
    void start({ video_path: form.video, output_root: settings.output_root, provider: form.provider, modality: form.modality,
                 jev_key: form.key, interval: form.interval, segment_seconds: form.seconds, settings, upload_consent: form.consent });
  }

  const progress = progressOf(stages, busy, !!report && !busy);
  return <div className={`app${collapsed ? " collapsed" : ""}`}>
    <TopBar preview={preview} engine={engine} busy={busy} report={report} visible={providers}
      segmentsKnown={stages.jev.total ?? stages.openai.total} filter={filter} onFilter={setFilter}
      run={run} video={run?.video ?? form.video} />
    <div className="progress-line" role="progressbar" aria-label="审核进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <i style={{ width: `${progress * 100}%` }} className={busy ? "busy" : undefined} />
    </div>
    <div className="workspace">
      <TaskPanel form={form} update={update} settings={settings} setSettings={setSettings} busy={busy} error={error} preview={preview}
        collapsed={collapsed} onCollapse={setCollapsed} onBrowse={d => { void browse(d); }} onSubmit={submit} />
      <section className="panel flow-panel">
        <header className="panel-head">
          <span><b>SIGNAL MAP</b> · 片段流向{preview && report && <span className="tag demo">DEMO 数据</span>}</span>
          <span className="meta">左：按时长排布的审核窗口（自上而下即视频时间）→ 中：处理阶段 → 右：判定</span>
        </header>
        <FlowMap report={report} providers={providers} stages={stages} busy={busy} selected={selected} onSelect={setSelected}
          meta={{ interval: form.interval, segmentSeconds: form.seconds, cloud: cloudAsr,
                  asr: cloudAsr ? `MiMo ${settings?.mimo_model ?? ""}` : `whisper ${settings?.asr_model ?? ""}` }} />
      </section>
    </div>
    <div className="dock">
      <Feed log={log} />
      <Pipeline stages={stages} message={message} />
      <Results report={report} providers={providers} segments={segments} selected={selected} onSelect={setSelected} preview={preview} />
      <Detail report={report} providers={providers} segment={segment} cloudAsr={cloudAsr} />
    </div>
  </div>;
}
