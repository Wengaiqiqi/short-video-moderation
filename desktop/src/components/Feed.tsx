import { memo } from "react";
import { fmtClock } from "../lib/report";
import type { LogEntry } from "../types";

/** One line never changes once written, so it renders once. */
const Line = memo(function Line({ entry }: { entry: LogEntry }) {
  return <li className={`l-${entry.level}`}>
    <time>{fmtClock(entry.at)}</time><span className="feed-tag">{entry.tag}</span><span className="feed-text" title={entry.text}>{entry.text}</span>
  </li>;
});

/** Event stream for this window, newest first. Re-renders only when a line is added. */
export default memo(function Feed({ log }: { log: LogEntry[] }) {
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>事件流水</b></span><span className="meta">{log.length}</span></header>
    <ol className="feed">
      {log.length === 0 && <li className="empty">等待引擎事件…</li>}
      {[...log].reverse().map(entry => <Line key={entry.id} entry={entry} />)}
    </ol>
  </section>;
});
