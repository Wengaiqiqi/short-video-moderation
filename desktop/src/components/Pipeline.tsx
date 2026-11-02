import { STAGE_ORDER } from "../useModeration";
import type { Stage, StageId } from "../types";

const NAMES: Record<StageId, [string, string]> = {
  engine: ["ENGINE", "引擎连接"], prepare: ["PREPARE", "抽帧 ∥ 云端转写"], align: ["ALIGN", "窗口对齐"],
  jev: ["JEV", "逐段推理"], openai: ["BASELINE", "对照组逐段"], report: ["REPORT", "生成报告"],
};
const STATE: Record<Stage["state"], string> = { wait: "WAIT", run: "RUN", pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export default function Pipeline({ stages, message, video, running }: {
  stages: Record<StageId, Stage>; message: string; video?: string; running: number;
}) {
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>PIPELINE</b></span>
      <span className="meta" title={video}>{video ? `${video}` : "—"}{running > 1 ? ` · 并行 ${running}` : ""}</span></header>
    <ul className="pipeline">
      {STAGE_ORDER.map(id => {
        const stage = stages[id];
        const ratio = stage.total ? (stage.done ?? 0) / stage.total : stage.state === "pass" ? 1 : 0;
        return <li key={id} className={`s-${stage.state}`}>
          <i className="sq" /><b>{NAMES[id][0]}</b><span className="name">{NAMES[id][1]}</span>
          <span className="mini" aria-hidden="true"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></span>
          <span className="count">{stage.total ? `${stage.done ?? 0}/${stage.total}` : ""}</span>
          <span className="state">{STATE[stage.state]}</span>
        </li>;
      })}
    </ul>
    <p className="pipeline-status" role="status" aria-live="polite" title={message}>{message}</p>
  </section>;
}
