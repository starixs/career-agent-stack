/**
 * 某段经历的保密补充字段（私密信息库 scope=experience）。
 * 经历库详情页与「私密信息」页共用：列出已有字段（脱敏预览 + 占位符）、新增、删除。
 */
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { careerApi } from './careerApi';
import { Button, Field, TextInput } from './CareerPrimitives';
import type { VaultItemMeta } from './types';
import { useCareerAction } from './useCareerData';

export function experiencePlaceholder(experienceId: string, field: string): string {
  return `{{vault:exp.${experienceId}.${field}}}`;
}

export function VaultExperienceFields({ experienceId, items, onChanged }: { experienceId: string; items: VaultItemMeta[]; onChanged: () => void }) {
  const action = useCareerAction();
  const [form, setForm] = useState({ field: '', label: '', value: '' });
  const add = () => action.run(async () => {
    const field = form.field.trim().replace(/[^A-Za-z0-9_]/g, '_');
    if (!field) throw new Error('请填写字段名（英文，如 org / client / revenue）');
    if (!form.value.trim()) throw new Error('请填写内容');
    await careerApi.vaultSet({ scope: 'experience', ref_id: experienceId, field, value: form.value, label: form.label || null });
    setForm({ field: '', label: '', value: '' });
    onChanged();
  });
  const remove = (id: string) => action.run(async () => { await careerApi.vaultDelete(id); onChanged(); });
  return (
    <div className="space-y-2">
      {items.map(i => (
        <div key={i.id} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[var(--ink)]">{i.label || i.field}</span>
          <span className="text-[var(--ink-muted)]">{i.preview || '已设置'}</span>
          <code className="rounded bg-[var(--paper-inset)] px-1 text-[var(--ink-muted)]">{experiencePlaceholder(experienceId, i.field)}</code>
          <Button variant="ghost" busy={action.busy} onClick={() => void remove(i.id)} aria-label={`删除 ${i.label || i.field}`}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[140px_160px_1fr_auto] md:items-end">
        <Field label="字段名（英文）"><TextInput value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))} placeholder="org" /></Field>
        <Field label="说明"><TextInput value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="真实公司名" /></Field>
        <Field label="内容（真实值）"><TextInput value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} autoComplete="off" /></Field>
        <Button variant="primary" busy={action.busy} onClick={() => void add()}><Plus className="h-3.5 w-3.5" />添加</Button>
      </div>
      {action.error && <div role="alert" className="text-xs text-[var(--error)]">{action.error}</div>}
    </div>
  );
}
