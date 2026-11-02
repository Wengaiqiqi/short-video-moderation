import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Detail from "./components/Detail";
import Feed from "./components/Feed";
import FlowMap from "./components/FlowMap";
import Pipeline from "./components/Pipeline";
import Results from "./components/Results";
import TaskPanel, { type TaskForm } from "./components/TaskPanel";
import TopBar from "./components/TopBar";
import { segmentsOf, stageProgress, visibleProviders, type ProviderFilter, type Verdict } from "./lib/report";
import { freshStages, useModeration } from "./useModeration";

export default function App() {
  const m = useModeration();
  const { preview, settings, setSettings, busy, videos, queueActive, stagesById } = m;
  const [form, setForm] = useState<TaskForm>({ provider: "both", modality: "multimodal", key: "", interval: 0.5, seconds: 8, consent: false });
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [bin, setBin] = useState<Verdict | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [segmentId, setSegmentId] = useState<number | null>(null);
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const update = (patch: Partial<TaskForm>) => setForm(f => ({ ...f, ...patch }));

  const video = videos.find(v => v.id === videoId) ?? null;
  const providers = useMemo(() => visibleProviders(video?.report, filter), [video, filter]);
  const segment = useMemo(() => segmentsOf(video?.report, providers).find(s => s.id === segmentId) ?? null, [video, providers, segmentId]);
  const cloudAsr = (m.batch?.asrEngine ?? settings?.asr_engine) === "mimo-cloud";

  function selectVideo(id: string | null) { setVideoId(id); setSegmentId(null); setFilter("all"); }
  function selectBin(next: Verdict | null) { setBin(next); setVideoId(null); setSegmentId(null); }

  async function addFiles() {
    setError("");
    if (preview) { m.addVideos([]); return; }
    try {
      const picked = await open({ multiple: true, filters: [{ name: "视频", extensions: ["mp4", "mkv", "mov", "webm"] }] });
      if (Array.isArray(picked)) m.addVideos(picked);
      else if (typeof picked === "string") m.addVideos([picked]);
    } catch (e) { setError(String(e)); }
  }
  async function addFolder() {
    setError("");
    if (preview) { void m.addFolder(); return; }
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") void m.addFolder(picked);
    } catch (e) { setError(String(e)); }
  }
  async function browseOutput() {
    if (preview || !settings) return;
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked === "string") setSettings({ ...settings, output_root: picked });
    } catch (e) { setError(String(e)); }
  }
  function start() {
    setError("");
    if (!settings || !settings.output_root.trim() || !form.consent) { setError("请选择结果目录，并确认发送内容。"); return; }
    if (!videos.some(v => v.status === "queued")) { setError("请先添加视频。"); return; }
    m.startQueue({ output_root: settings.output_root, provider: form.provider, modality: form.modality, jev_key: form.key,
                   interval: form.interval, segment_seconds: form.seconds, settings, upload_consent: form.consent });
  }

  const pending = videos.filter(v => v.status === "queued" || v.status === "running").length;
  const total = videos.filter(v => v.status !== "queued" || queueActive).length;
  const done = videos.filter(v => v.status === "done" || v.status === "failed").length;
  const partial = videos.filter(v => v.status === "running").reduce((a, v) => a + (stagesById[v.id] ? stageProgress(stagesById[v.id]) : 0), 0);
  const progress = (queueActive || busy) && total ? Math.min(1, (done + partial) / total) : done && !pending ? 1 : 0;
  // The pipeline panel follows the selected video, else the earliest running one, else the last finished.
  const focus = (video && stagesById[video.id] ? video : null)
    ?? videos.find(v => v.status === "running")
    ?? [...videos].reverse().find(v => stagesById[v.id]) ?? null;

  return <div className={`app${collapsed ? " collapsed" : ""}`}>
    <TopBar preview={preview} engine={m.engine} busy={busy} videos={videos} batch={m.batch} queueActive={queueActive} limit={m.limit} />
    <div className="progress-line" role="progressbar" aria-label="队列进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <i style={{ width: `${progress * 100}%` }} className={busy ? "busy" : undefined} />
    </div>
    <div className="workspace">
      <TaskPanel form={form} update={update} settings={settings} setSettings={setSettings} videos={videos} queueActive={queueActive}
        busy={busy} error={error} preview={preview} collapsed={collapsed} onCollapse={setCollapsed}
        onAddFiles={() => { void addFiles(); }} onAddFolder={() => { void addFolder(); }} onAddPath={path => m.addVideos([path])}
        onBrowseOutput={() => { void browseOutput(); }} onRemove={m.removeVideo} onClearQueued={m.clearQueued}
        onStart={start} onStop={m.stopQueue} running={m.running} limit={m.limit} />
      <section className="panel flow-panel">
        <header className="panel-head">
          <span><b>SIGNAL MAP</b> · 视频流向{preview && <span className="tag demo">DEMO 数据</span>}</span>
          <span className="meta">左：待审视频 → 中：处理阶段 → 右：判定（点击查看）</span>
        </header>
        <FlowMap videos={videos} stagesById={stagesById} selected={videoId} onSelect={selectVideo} bin={bin} onBin={selectBin}
          meta={{ interval: form.interval, segmentSeconds: form.seconds, cloud: cloudAsr,
                  asr: cloudAsr ? `MiMo ${settings?.mimo_model ?? ""}` : `whisper ${settings?.asr_model ?? ""}` }} />
      </section>
    </div>
    <div className="dock">
      <Feed log={m.log} />
      <Pipeline stages={focus ? stagesById[focus.id] ?? freshStages() : freshStages()} message={m.message} video={focus?.name}
        running={m.running} />
      <Results videos={videos} video={video} onVideo={selectVideo} bin={bin} onBin={selectBin}
        segment={segmentId} onSegment={setSegmentId} filter={filter} onFilter={setFilter} preview={preview} />
      <Detail video={video} providers={providers} segment={segment} cloudAsr={cloudAsr} />
    </div>
  </div>;
}
