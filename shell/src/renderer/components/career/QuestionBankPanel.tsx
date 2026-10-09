/**
 * 题库（R09）：总题库 + 我见过的题 + 按 JD 出的题；笔试 / 测评题也在这里。
 * 每道题看得到见过几次、练过几次、最近 / 最好得分；点开看每次作答的分数变化（绑定当时的简历与岗位）。
 * 练习与打分在对话里做（"用这道题考我"），这里负责查看、筛选、补录自己见过的题。
 */
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { careerApi } from './careerApi';
import { Badge, Button, ChatActionButton, ErrorRow, LoadingRow, SectionTitle, Select, TextArea, TextInput, formatDate, type BadgeTone } from './CareerPrimitives';
import type { QuestionItem } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

const SOURCE: Record<QuestionItem['source'], { label: string; tone: BadgeTone }> = { seen: { label: '我见过', tone: 'accent' }, public: { label: '公共题库', tone: 'info' }, generated: { label: '按 JD 出的', tone: 'neutral' } };
const KIND: Record<QuestionItem['kind'], string> = { interview: '面试', written: '笔试', assessment: '测评' };

export function QuestionBankPanel() {
  const [f, setF] = useState<{ kind?: string; source?: string; q?: string; weak_only?: boolean }>({});
  const query = useCareerQuery(() => careerApi.questions(f), ['question']);
  const set = (patch: typeof f) => { setF(cur => ({ ...cur, ...patch })); query.reload(); };
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const list = query.data ?? [];
  return (
    <section>
      <SectionTitle extra={<Button size="sm" onClick={() => setAdding(v => !v)}><Plus className="h-3.5 w-3.5" />补录见过的题</Button>}>
        题库（{list.length}）
      </SectionTitle>
      {adding && <AddQuestion onDone={() => { setAdding(false); query.reload(); }} />}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <TextInput aria-label="搜索题目" placeholder="搜题干 / 题型 / 标签" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') set({ q }); }} className="w-48" />
        <Select ariaLabel="题目类型" value={f.kind ?? ''} placeholder="全部类型" onChange={v => set({ kind: v || undefined })} options={[{ value: '', label: '全部类型' }, { value: 'interview', label: '面试' }, { value: 'written', label: '笔试' }, { value: 'assessment', label: '测评' }]} />
        <Select ariaLabel="题目来源" value={f.source ?? ''} placeholder="全部来源" onChange={v => set({ source: v || undefined })} options={[{ value: '', label: '全部来源' }, { value: 'seen', label: '我见过' }, { value: 'public', label: '公共题库' }, { value: 'generated', label: '按 JD 出的' }]} />
        <label className="flex items-center gap-1 text-[var(--muted)]"><input type="checkbox" checked={!!f.weak_only} onChange={e => set({ weak_only: e.target.checked })} />只看没练 / 不到 60 分</label>
      </div>
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {query.loading && !query.data && <LoadingRow />}
      {query.data && list.length === 0 && <div className="text-xs text-[var(--subtle)]">还没有题目。让助理按岗位出题、复盘一场真实面试，或者补录你见过的题，都会存到这里。</div>}
      <ul className="space-y-1.5">{list.map(item => <QuestionRowView key={item.id} item={item} onChanged={query.reload} />)}</ul>
    </section>
  );
}

function QuestionRowView({ item, onChanged }: { item: QuestionItem; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const attempts = useCareerQuery(() => (open ? careerApi.questionAttempts(item.id) : Promise.resolve([])), ['question']);
  const act = useCareerAction();
  const probe = safeList(item.probe_points_json);
  return (
    <li className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone={SOURCE[item.source].tone}>{SOURCE[item.source].label}</Badge>
        <span className="text-[var(--muted)]">{KIND[item.kind]}{item.category ? ` · ${item.category}` : ''}{item.company_name ? ` · ${item.company_name}` : ''}</span>
        {item.seen_count > 0 && <span className="text-[var(--subtle)]">见过 {item.seen_count} 次</span>}
        <span className="text-[var(--subtle)]">{item.attempt_count ? `练过 ${item.attempt_count} 次 · 最近 ${item.last_attempt_score ?? '—'} · 最好 ${item.best_attempt_score ?? '—'}` : '还没练过'}</span>
        <span className="flex-1" />
        <ChatActionButton variant="ghost" text={`用这道题考我：${item.content}`} context={{ surface: 'review', refs: { question_id: item.id } }}>练这道</ChatActionButton>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(v => !v); attempts.reload(); }}>{open ? '收起' : '作答记录'}</Button>
        <Button size="sm" variant="ghost" aria-label="删除题目" busy={act.busy} onClick={() => void act.run(async () => { await careerApi.deleteQuestion(item.id); onChanged(); })}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--ink)]">{item.content}</div>
      {probe.length > 0 && <div className="mt-0.5 text-xs text-[var(--muted)]">考察点：{probe.join('；')}</div>}
      {open && (
        <div className="mt-1.5 border-t border-[var(--line)] pt-1.5 text-xs">
          {(attempts.data ?? []).length === 0 && <div className="text-[var(--subtle)]">还没有作答记录。</div>}
          <ul className="space-y-1">
            {(attempts.data ?? []).map(a => (
              <li key={a.id}><span className="tabular-nums text-[var(--ink)]">{a.score ?? '—'} 分</span><span className="ml-1.5 text-[var(--subtle)]">{formatDate(a.created_at)} · {a.mode}</span>{a.answer_text && <div className="text-[var(--muted)]">{a.answer_text.slice(0, 200)}</div>}</li>
            ))}
          </ul>
        </div>
      )}
      {act.error && <ErrorRow message={act.error} />}
    </li>
  );
}

function AddQuestion({ onDone }: { onDone: () => void }) {
  const [content, setContent] = useState('');
  const [company, setCompany] = useState('');
  const [kind, setKind] = useState('interview');
  const act = useCareerAction();
  const save = () => act.run(async () => {
    const lines = content.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('写下题目（一行一道）');
    for (const line of lines) await careerApi.addQuestion({ content: line, kind, company_name: company.trim() || undefined, source: 'seen' });
    setContent(''); onDone();
  });
  return (
    <div className="mb-3 space-y-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2">
      <TextArea aria-label="见过的题" placeholder="一行一道，按原话写" rows={3} value={content} onChange={e => setContent(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <TextInput aria-label="哪家公司" placeholder="哪家公司（可选）" value={company} onChange={e => setCompany(e.target.value)} className="w-40" />
        <Select ariaLabel="补录类型" value={kind} onChange={setKind} options={[{ value: 'interview', label: '面试题' }, { value: 'written', label: '笔试题' }, { value: 'assessment', label: '测评题' }]} />
        <Button size="sm" variant="primary" busy={act.busy} onClick={() => void save()}>存进题库</Button>
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function safeList(raw: string): string[] { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } }
