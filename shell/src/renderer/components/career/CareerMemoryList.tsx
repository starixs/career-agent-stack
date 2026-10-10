/**
 * 「我的资料 / 助理记住的事」：长期记忆的看、改、删、置顶、手动加。
 * 数据来自 Global `/api/career/memories`；对话里新记下的会通过 `career:data-changed (memory)` 自动刷新。
 */
import { Pin, PinOff } from 'lucide-react';
import { useMemo, useState } from 'react';

import { careerApi } from './careerApi';
import { Badge, Button, Card, EmptyState, ErrorRow, LoadingRow, Select, TextArea, TextInput, formatDate, type BadgeTone } from './CareerPrimitives';
import type { MemoryItem, MemoryKind } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = { collaboration: '协作习惯', preference: '偏好', fact: '事实', insight: '自我认识' };
const KIND_TONES: Record<MemoryKind, BadgeTone> = { collaboration: 'accent', preference: 'info', fact: 'neutral', insight: 'success' };
const SOURCE_LABELS: Record<MemoryItem['source'], string> = { explicit: '你让它记的', extracted: '对话中记下', user_edit: '你改过', consolidation: '整理合并' };
const KIND_OPTIONS = (Object.keys(MEMORY_KIND_LABELS) as MemoryKind[]).map(k => ({ value: k, label: MEMORY_KIND_LABELS[k] }));

/** scope → 分组标题。 */
export function scopeLabel(scope: string): string {
  if (scope.startsWith('company:')) return scope.slice('company:'.length);
  if (scope.startsWith('application:')) return `某次投递（${scope.slice('application:'.length)}）`;
  return '通用';
}

/** 按 scope 分组：通用在前，其余按名字。组内保持接口返回的顺序（置顶 > 重要度 > 更新时间）。 */
export function groupMemories(items: MemoryItem[]): Array<{ scope: string; label: string; items: MemoryItem[] }> {
  const map = new Map<string, MemoryItem[]>();
  for (const m of items) { const list = map.get(m.scope) ?? []; list.push(m); map.set(m.scope, list); }
  return [...map.entries()]
    .map(([scope, list]) => ({ scope, label: scopeLabel(scope), items: list }))
    .sort((a, b) => (a.scope === 'user' ? -1 : b.scope === 'user' ? 1 : a.label.localeCompare(b.label, 'zh')));
}

export function CareerMemoryList() {
  const [q, setQ] = useState('');
  const query = useCareerQuery(() => careerApi.memories(), ['memory']);
  const [adding, setAdding] = useState(false);
  const visible = useMemo(() => {
    const items = query.data ?? [];
    const term = q.trim();
    return term ? items.filter(m => m.content.includes(term) || scopeLabel(m.scope).includes(term)) : items;
  }, [query.data, q]);
  const groups = useMemo(() => groupMemories(visible), [visible]);

  return (
    <div className="space-y-5 px-6 py-6">
      <p className="text-sm text-[var(--muted)]">
        助理会在对话里记下你的协作习惯、偏好和跟某家公司有关的事，下次自动照着做。记错了就改或忘掉；姓名、手机这类个人信息不会记在这里。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1"><TextInput value={q} onChange={e => setQ(e.target.value)} placeholder="搜索记忆" aria-label="搜索记忆" /></div>
        <Button variant="primary" onClick={() => setAdding(v => !v)}>{adding ? '收起' : '添加一条'}</Button>
      </div>
      {adding && <AddMemory onDone={() => { setAdding(false); query.reload(); }} />}
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {query.loading && !query.data && <LoadingRow />}
      {query.data && !visible.length && (
        q.trim()
          ? <EmptyState title="没有匹配的记忆" hint="换个关键词试试" />
          : <EmptyState title="助理还没记下什么" hint="在对话里说「记住：……」，或者正常聊几轮，它会自己记下你的习惯和偏好。" example="记住：回复先说结论，三句话以内" />
      )}
      {groups.map(g => (
        <Card key={g.scope} title={g.label} extra={<span className="text-xs text-[var(--muted)]">{g.items.length} 条</span>}>
          <ul className="divide-y divide-[var(--line)]">
            {g.items.map(m => <MemoryRow key={m.id} memory={m} onChanged={query.reload} />)}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function MemoryRow({ memory, onChanged }: { memory: MemoryItem; onChanged: () => void }) {
  const action = useCareerAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const save = async () => {
    const ok = await action.run(() => careerApi.updateMemory(memory.id, { content: draft, kind }));
    if (ok) { setEditing(false); onChanged(); }
  };
  return (
    <li className="py-3" data-testid="memory-row">
      {editing ? (
        <div className="space-y-2">
          <TextArea value={draft} onChange={e => setDraft(e.target.value)} rows={2} aria-label="记忆内容" />
          <div className="flex items-center gap-2">
            <div className="w-32"><Select value={kind} options={KIND_OPTIONS} onChange={v => setKind(v as MemoryKind)} ariaLabel="记忆类型" /></div>
            <Button variant="primary" size="sm" busy={action.busy} disabled={!draft.trim()} onClick={() => void save()}>保存</Button>
            <Button size="sm" onClick={() => { setEditing(false); setDraft(memory.content); setKind(memory.kind); }}>取消</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge tone={KIND_TONES[memory.kind]}>{MEMORY_KIND_LABELS[memory.kind]}</Badge>
              {!!memory.pinned && <Badge tone="warning">置顶</Badge>}
            </div>
            <div className="mt-1 text-sm text-[var(--ink)]">{memory.content}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">
              {SOURCE_LABELS[memory.source]}{memory.evidence_count > 1 ? ` · 提到过 ${memory.evidence_count} 次` : ''} · {formatDate(memory.updated_at)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" aria-label={memory.pinned ? '取消置顶' : '置顶'} title={memory.pinned ? '取消置顶' : '置顶：总是带上这条'} busy={action.busy}
              onClick={() => void action.run(() => careerApi.updateMemory(memory.id, { pinned: !memory.pinned })).then(r => { if (r) onChanged(); })}>
              {memory.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>编辑</Button>
            <Button size="sm" variant="ghost" busy={action.busy}
              onClick={() => void action.run(() => careerApi.forgetMemory(memory.id)).then(r => { if (r !== undefined) onChanged(); })}>忘掉</Button>
          </div>
        </div>
      )}
      {action.error && <div role="alert" className="mt-1 text-xs text-[var(--danger)]">{action.error}</div>}
    </li>
  );
}

function AddMemory({ onDone }: { onDone: () => void }) {
  const action = useCareerAction();
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('collaboration');
  const [company, setCompany] = useState('');
  const submit = async () => {
    const ok = await action.run(() => careerApi.addMemory({ content, kind, scope: company.trim() ? `company:${company.trim()}` : 'user' }));
    if (ok) onDone();
  };
  return (
    <Card title="添加一条">
      <div className="space-y-2">
        <TextArea value={content} onChange={e => setContent(e.target.value)} rows={2} placeholder="例如：回复先说结论，三句话以内" aria-label="新记忆内容" />
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-32"><Select value={kind} options={KIND_OPTIONS} onChange={v => setKind(v as MemoryKind)} ariaLabel="新记忆类型" /></div>
          <div className="w-48"><TextInput value={company} onChange={e => setCompany(e.target.value)} placeholder="只和某家公司有关？填公司名" aria-label="相关公司" /></div>
          <Button variant="primary" busy={action.busy} disabled={!content.trim()} onClick={() => void submit()}>记住</Button>
        </div>
        {action.error && <div role="alert" className="text-xs text-[var(--danger)]">{action.error}</div>}
      </div>
    </Card>
  );
}
