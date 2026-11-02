import { STAGE_ORDER } from "../useModeration";
import type { Stage, StageId } from "../types";

const NAMES: Record<StageId, string> = {
  engine: "引擎连接", prepare: "抽帧 ∥ 语音转写", align: "窗口对齐", jev: "JEV 逐段判断", openai: "对照组逐段判断", report: "生成报告",
};
const STATE: Record<Stage["state"], string> = { wait: "等待", run: "进行中", pass: "完成", warn: "有失败", fail: "失败", skip: "跳过" };

export default function Pipeline({ stages, message, video, running }: {
  stages: Record<StageId, Stage>; message: string; video?: string; running: number;
}) {
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>流程阶段</b></span>
      <span className="meta" title={video}>{video ? `${video}` : "—"}{running > 1 ? ` · 并行 ${running}` : ""}</span></header>
    <ul className="pipeline">
      {STAGE_ORDER.map(id => {
        const stage = stages[id];
        const ratio = stage.total ? (stage.done ?? 0) / stage.total : stage.state === "pass" ? 1 : 0;
        return <li key={id} className={`s-${stage.state}`}>
          <i className="sq" /><span className="name">{NAMES[id]}</span>
          <span className="mini" aria-hidden="true"><i style={{ width: `${Math.round(ratio * 100)}%` }} /></span>
          <span className="count">{stage.total ? `${stage.done ?? 0}/${stage.total}` : ""}</span>
          <span className="state">{STATE[stage.state]}</span>
        </li>;
      })}
    </ul>
    <p className="pipeline-status" role="status" aria-live="polite" title={message}>{message}</p>
  </section>;
}
