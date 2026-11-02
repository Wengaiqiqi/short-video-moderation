import { fmtClock } from "../lib/report";
import type { LogEntry } from "../types";

/** Event stream for this window, newest first. */
export default function Feed({ log }: { log: LogEntry[] }) {
  return <section className="panel dock-panel">
    <header className="panel-head"><span><b>FEED</b></span><span className="meta">{log.length}</span></header>
    <ol className="feed">
      {log.length === 0 && <li className="empty">等待引擎事件…</li>}
      {[...log].reverse().map(entry => <li key={entry.id} className={`l-${entry.level}`}>
        <time>{fmtClock(entry.at)}</time><span className="feed-tag">{entry.tag}</span><span className="feed-text" title={entry.text}>{entry.text}</span>
      </li>)}
    </ol>
  </section>;
}
