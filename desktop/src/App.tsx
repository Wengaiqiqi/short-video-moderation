import { useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import Calibration from "./components/Calibration";
import Detail from "./components/Detail";
import { EvidenceModal } from "./components/Evidence";
import Feed from "./components/Feed";
import FlowMap from "./components/FlowMap";
import Pipeline from "./components/Pipeline";
import Results, { type Rerun } from "./components/Results";
import TaskPanel, { type TaskForm } from "./components/TaskPanel";
import TopBar from "./components/TopBar";
import { VERDICT_ZH, categoryLabel, disagreements, finalVerdict, providersOf, segmentsOf, stageProgress, tally,
         tokensOf, visibleProviders, type ProviderFilter, type Verdict } from "./lib/report";
import { freshStages, useModeration, type RunConfig } from "./useModeration";
import type { VideoItem } from "./types";

/** One CSV row per video: the final verdict next to the model verdict, counts, main category and usage. */
function exportRows(videos: VideoItem[]) {
  const header = ["视频", "路径", "最终结论", "模型结论", "人工终判", "备注", "片段数", "拦截段", "待定段", "失败段", "分歧段",
                  "主要类别", "最高分", "tokens", "完成时间", "报告"];
  return [header, ...videos.map(v => {
    const counts = Object.values(tally(v.report, providersOf(v.report)));
    const sum = (k: "block" | "review" | "failed") => counts.reduce((a, c) => a + c[k], 0);
    let top = "", peak = 0;
    for (const data of Object.values(v.report?.providers ?? {})) for (const row of data.segments)
      for (const [c, p] of Object.entries(row.probabilities ?? {})) if (p > peak) { peak = p; top = c; }
    const verdict = finalVerdict(v);
    return [v.name, v.part?.source ?? v.path, verdict ? VERDICT_ZH[verdict] : "失败", v.verdict ? VERDICT_ZH[v.verdict] : "",
            v.review ? VERDICT_ZH[v.review.decision] : "", v.review?.note ?? "",
            Math.max(0, ...Object.values(v.report?.providers ?? {}).map(p => p.segments.length)), sum("block"), sum("review"), sum("failed"),
            disagreements(v.report).size, top ? categoryLabel(top, v.report) : "", peak.toFixed(3),
            Object.values(v.report?.providers ?? {}).reduce((a, p) => a + tokensOf(p.usage), 0),
            v.finishedAt ? new Date(v.finishedAt).toLocaleString("zh-CN", { hour12: false }) : "", v.report?.report_path ?? ""];
  })];
}

export default function App() {
  const m = useModeration();
  const { preview, settings, setSettings, busy, videos, queueActive, stagesById } = m;
  const [form, setForm] = useState<TaskForm>({ provider: "both", modality: "multimodal", interval: 0.5, seconds: 8 });
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [bin, setBin] = useState<Verdict | null>(null);
  const [scope, setScope] = useState<"batch" | "history">("batch");
  const [videoId, setVideoId] = useState<string | null>(null);
  const [segmentId, setSegmentId] = useState<number | null>(null);
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const update = (patch: Partial<TaskForm>) => setForm(f => ({ ...f, ...patch }));

  const video = videos.find(v => v.id === videoId) ?? null;
  const providers = useMemo(() => visibleProviders(video?.report, filter), [video, filter]);
  const segments = useMemo(() => segmentsOf(video?.report, providers), [video, providers]);
  const segment = segments.find(s => s.id === segmentId) ?? null;
  const cloudAsr = (m.batch?.asrEngine ?? settings?.asr_engine) === "mimo-cloud";

  function selectVideo(id: string | null) {
    setVideoId(id); setSegmentId(null); setFilter("all");
    const picked = videos.find(v => v.id === id);
    if (picked) setScope(picked.history ? "history" : "batch");
  }
  function selectBin(next: Verdict | null) { setBin(next); setVideoId(null); setSegmentId(null); }

  /** Run settings from the form; keys are passed separately and never stored with the settings. */
  function runConfig(how?: Partial<Rerun>): RunConfig | null {
    if (!settings || !settings.output_root.trim()) { setError("请选择结果目录"); return null; }
    const { jev_api_key, category_presets, keychain_available, stored_keys, ...rest } = settings;
    return { output_root: settings.output_root, provider: how?.provider ?? form.provider, modality: how?.modality ?? form.modality,
             jev_key: jev_api_key ?? "", interval: form.interval, segment_seconds: form.seconds, settings: rest, upload_consent: true };
  }

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
    if (!videos.some(v => v.status === "queued")) { setError("请先添加视频。"); return; }
    const run = runConfig();
    if (run) m.startQueue(run);
  }
  async function exportCsv(list: VideoItem[]) {
    const rows = exportRows(list);
    const name = `审核结果-${new Date().toISOString().slice(0, 10)}.csv`;
    if (preview) {
      const text = "﻿" + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }
    try {
      const path = await save({ defaultPath: name, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      const answer = await m.request("export_csv", { path, rows });
      if (answer.error) setError(String(answer.error));
    } catch (e) { setError(String(e)); }
  }
  async function importLabels() {
    if (preview) return [{ name: "01-街头采访.mp4", blocked: false }, { name: "03-宠物日常.mp4", blocked: true }];
    const path = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (typeof path !== "string") return null;
    const answer = await m.request("read_labels", { path });
    if (answer.error) throw new Error(String(answer.error));
    return answer.labels as { name: string; blocked: boolean }[];
  }

  const pending = videos.filter(v => v.status === "queued" || v.status === "running").length;
  const total = videos.filter(v => !v.history && (v.status !== "queued" || queueActive)).length;
  const done = videos.filter(v => !v.history && (v.status === "done" || v.status === "failed")).length;
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
        onStart={start} onStop={m.stopQueue} running={m.running} limit={m.limit}
        onCancel={m.cancelVideo} onCancelAll={m.cancelAll} onRequeue={id => { const run = runConfig(); if (run) m.requeue(id, run); }} />
      <section className="panel flow-panel">
        <header className="panel-head">
          <span><b>SIGNAL MAP</b>{preview && <span className="tag demo">DEMO</span>}</span>
        </header>
        <FlowMap videos={videos} stagesById={stagesById} selected={videoId} onSelect={selectVideo} bin={bin} onBin={selectBin}
          meta={{ interval: form.interval, segmentSeconds: form.seconds, cloud: cloudAsr,
                  asr: cloudAsr ? "MiMo" : `Whisper ${settings?.asr_model ?? ""}` }} />
      </section>
    </div>
    <div className="dock">
      <Feed log={m.log} />
      <Pipeline stages={focus ? stagesById[focus.id] ?? freshStages() : freshStages()} message={m.message} video={focus?.name}
        running={m.running} />
      <Results videos={videos} video={video} onVideo={selectVideo} bin={bin} onBin={selectBin}
        segment={segmentId} onSegment={setSegmentId} filter={filter} onFilter={setFilter} preview={preview}
        scope={scope} onScope={s => { setScope(s); setBin(null); }} onExport={list => { void exportCsv(list); }}
        onRefreshHistory={() => { void m.loadHistory(); }}
        onReview={(id, decision) => { void m.setReview(id, decision); }}
        onRetryFailed={id => { const run = runConfig(); if (run) m.retryFailed(id, run); }}
        onRerun={(id, how) => { const run = runConfig(how); if (run) m.reevaluate(id, run); }}
        onCancel={m.cancelVideo} onRequeue={id => { const run = runConfig(); if (run) m.requeue(id, run); }} />
      <Detail video={video} videos={videos} providers={providers} segment={segment} cloudAsr={cloudAsr} settings={settings}
        request={m.request} onOpenEvidence={() => setEvidenceOpen(true)} onCalibrate={() => setCalibrating(true)} />
    </div>
    {evidenceOpen && video && segment && <EvidenceModal video={video} segments={segments} segment={segment} providers={providers}
      request={m.request} onSegment={setSegmentId} onClose={() => setEvidenceOpen(false)}
      onReview={decision => { void m.setReview(video.id, decision); }} />}
    {calibrating && settings && <Calibration videos={videos} policy={settings.policy} onClose={() => setCalibrating(false)}
      onImport={importLabels}
      onApply={patch => settings.policy && setSettings({ ...settings, policy: { ...settings.policy, ...patch,
        review_threshold: Math.round(Math.min(patch.review_threshold ?? settings.policy.review_threshold,
                                              (patch.block_threshold ?? settings.policy.block_threshold) - 0.05) * 100) / 100 } })} />}
  </div>;
}

