import { useState } from "react";
import type { CategoryRule, ModerationPolicy, Settings } from "../types";

const round = (v: number) => Math.round(v * 100) / 100;

/** Edit the moderation categories: switch them on/off, per-category thresholds, criteria, add from the library. */
export default function RulesEditor({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const policy = settings.policy;
  const [open, setOpen] = useState<string | null>(null);
  if (!policy) return <p className="hint">规则加载中…</p>;
  const presets = settings.category_presets ?? {};
  const set = (next: ModerationPolicy) => onChange({ ...settings, policy: next });
  const setRule = (id: string, patch: Partial<CategoryRule>) => {
    const next = { ...policy, categories: { ...policy.categories, [id]: { ...policy.categories[id], ...patch } } };
    set(next);
  };
  const clearOverride = (id: string, key: "review_threshold" | "block_threshold") => {
    const rule = { ...policy.categories[id] };
    delete rule[key];
    set({ ...policy, categories: { ...policy.categories, [id]: rule } });
  };
  const missing = Object.entries(presets).filter(([id]) => !policy.categories[id]);
  const enabled = Object.values(policy.categories).filter(r => r.enabled !== false).length;
  const invalid = !(policy.review_threshold < policy.block_threshold);

  return <>
    <div className="group">
      <h3>全局阈值<span className="h-meta">启用 {enabled} 类</span></h3>
      <div className="pair">
        <label className="field">复核 ≥<input type="number" min={0} max={1} step={0.05} value={policy.review_threshold}
          onChange={e => set({ ...policy, review_threshold: round(Number(e.target.value)) })} /></label>
        <label className="field">拦截 ≥<input type="number" min={0} max={1} step={0.05} value={policy.block_threshold}
          onChange={e => set({ ...policy, block_threshold: round(Number(e.target.value)) })} /></label>
      </div>
      {invalid && <p className="form-error">复核阈值需小于拦截阈值</p>}
    </div>
    <div className="group">
      <h3>类别</h3>
      <ul className="rules">
        {Object.entries(policy.categories).map(([id, rule]) => {
          const on = rule.enabled !== false;
          return <li key={id} className={on ? undefined : "off"}>
            <div className="rule-head">
              <label className="switch-field"><input type="checkbox" checked={on} onChange={e => setRule(id, { enabled: e.target.checked })} />
                <span className="toggle" aria-hidden="true" /><b>{rule.label ?? id}</b></label>
              <span className="rule-thr">
                <input type="number" min={0} max={1} step={0.05} aria-label={`${rule.label ?? id} 复核阈值`} placeholder={String(policy.review_threshold)}
                  title={rule.review_threshold != null ? "本类单独阈值，清空恢复全局" : undefined}
                  onWheel={e => e.currentTarget.blur()} value={rule.review_threshold ?? ""} onChange={e => e.target.value === "" ? clearOverride(id, "review_threshold") : setRule(id, { review_threshold: round(Number(e.target.value)) })} />
                <input type="number" min={0} max={1} step={0.05} aria-label={`${rule.label ?? id} 拦截阈值`} placeholder={String(policy.block_threshold)}
                  title={rule.block_threshold != null ? "本类单独阈值，清空恢复全局" : undefined}
                  onWheel={e => e.currentTarget.blur()} value={rule.block_threshold ?? ""} onChange={e => e.target.value === "" ? clearOverride(id, "block_threshold") : setRule(id, { block_threshold: round(Number(e.target.value)) })} />
              </span>
              <button type="button" className="icon-button" aria-expanded={open === id} title="编辑判定标准" onClick={() => setOpen(open === id ? null : id)}>✎</button>
            </div>
            {open === id && <div className="rule-body">
              <label className="field">中文名<input value={rule.label ?? ""} onChange={e => setRule(id, { label: e.target.value })} /></label>
              <label className="field">问题<textarea rows={2} value={rule.question} onChange={e => setRule(id, { question: e.target.value })} /></label>
              <label className="field">判为是<textarea rows={2} value={rule.positive} onChange={e => setRule(id, { positive: e.target.value })} /></label>
              <label className="field">判为否<textarea rows={2} value={rule.negative} onChange={e => setRule(id, { negative: e.target.value })} /></label>
              <button type="button" className="link-button" disabled={Object.keys(policy.categories).length <= 1} onClick={() => {
                const rest = { ...policy.categories };
                delete rest[id];
                set({ ...policy, categories: rest });
                setOpen(null);
              }}>移除此类</button>
            </div>}
          </li>;
        })}
      </ul>
      <p className="hint">两个数字为本类的复核 / 拦截阈值，留空则用全局值。</p>
    </div>
    {missing.length > 0 && <div className="group">
      <h3>添加类别</h3>
      <div className="preset-row">{missing.map(([id, rule]) => <button key={id} type="button" className="tool"
        onClick={() => set({ ...policy, categories: { ...policy.categories, [id]: { ...rule, enabled: true } } })}>＋ {rule.label ?? id}</button>)}</div>
    </div>}
  </>;
}
