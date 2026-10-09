/**
 * 素材：一套说法复用到几十家，前后一致。
 * 视图：说法库（新）/ 经历与主张（嵌入 CareerExperience）/ 简历（嵌入 CareerResume）。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { onEvent } from '@/api/eventBus';
import { careerApi } from '@/components/career/careerApi';
import {
  Badge, Button, CareerPage, Card, ChatActionButton, EmptyState, ErrorRow, Field, LoadingRow, Select, TextArea, TextInput, formatDate,
} from '@/components/career/CareerPrimitives';
import type { CareerFocusEvent, Material, MaterialKind, MaterialUse } from '@/components/career/types';
import { useCareerAction, useCareerQuery } from '@/components/career/useCareerData';
import type { CareerPageProps } from '@/features/career-shared/pageContract';

const CareerExperience = lazy(() => import('@/pages/CareerExperience'));
const CareerResume = lazy(() => import('@/pages/CareerResume'));

type View = 'library' | 'experience' | 'resume';
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'library', label: '说法库' }, { value: 'experience', label: '经历与主张' }, { value: 'resume', label: '简历' },
];

/** 素材类型文案（共享常量里没有，先放在本页）。 */
const MATERIAL_KIND_LABELS: Record<MaterialKind, string> = {
  open_question: '开放题', project_story: '项目故事', self_intro: '自我介绍', why_company: '为什么选公司',
  why_role: '为什么选岗位', strength_weakness: '优缺点', career_plan: '职业规划', other: '其他',
};
const MATERIAL_KINDS = Object.keys(MATERIAL_KIND_LABELS) as MaterialKind[];
const KIND_OPTIONS = MATERIAL_KINDS.map(k => ({ value: k, label: MATERIAL_KIND_LABELS[k] }));

interface MaterialData { materials: Material[]; uses: MaterialUse[] }
async function loadAll(): Promise<MaterialData> {
  const [materials, uses] = await Promise.all([careerApi.materials(), careerApi.materialUses()]);
  return { materials, uses };
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-[var(--line)] bg-[var(--inset)] p-0.5">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${o.value === value ? 'bg-[var(--bg)] text-[var(--ink)] shadow-sm' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function CareerMaterial({ embedded = false }: CareerPageProps) {
  const [view, setView] = useState<View>('library');
  const [focusId, setFocusId] = useState<string | null>(null);
  const query = useCareerQuery(loadAll, ['material', 'material_use']);
  const data = query.data;

  useEffect(() => onEvent<CareerFocusEvent>('career:focus', payload => {
    if (payload?.surface !== 'material') return;
    if (payload.id) setFocusId(payload.id);
    else { setFocusId(null); setView('library'); }
  }), []);

  // 焦点 id 是素材 → 说法库里高亮；不是（比如主简历 id）→ 简历视图。纯派生，用户手动切视图即清除焦点。
  const focusKind = focusId && data ? (data.materials.some(m => m.id === focusId) ? 'material' : 'other') : null;
  const effectiveView: View = focusKind === 'material' ? 'library' : focusKind === 'other' ? 'resume' : view;
  const highlightId = focusKind === 'material' ? focusId : null;
  const changeView = (v: View) => { setFocusId(null); setView(v); };

  return (
    <CareerPage
      embedded={embedded}
      title="素材"
      subtitle="一套说法复用到几十家，前后一致"
      examples={['帮我写一段“为什么选择我们”', '给我一分钟版自我介绍', '把这个项目写成 STAR 故事']}
      actions={<Segmented value={effectiveView} options={VIEWS} onChange={changeView} />}
    >
      {effectiveView === 'library' && (
        <div className="space-y-4 px-4 py-3">
          {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
          {query.loading && !data && <LoadingRow />}
          {data && <Library data={data} highlightId={highlightId} onChanged={query.reload} />}
        </div>
      )}
      {effectiveView !== 'library' && (
        <Suspense fallback={<div className="px-4"><LoadingRow /></div>}>
          {effectiveView === 'experience' && <CareerExperience embedded />}
          {effectiveView === 'resume' && <CareerResume embedded />}
        </Suspense>
      )}
    </CareerPage>
  );
}

function Library({ data, highlightId, onChanged }: { data: MaterialData; highlightId: string | null; onChanged: () => void }) {
  const [kindFilter, setKindFilter] = useState<MaterialKind | 'all'>('all');
  const [creating, setCreating] = useState(false);
  const usesByMaterial = useMemo(() => {
    const m = new Map<string, MaterialUse[]>();
    for (const u of data.uses) {
      if (!u.material_id) continue;
      const list = m.get(u.material_id) ?? [];
      list.push(u);
      m.set(u.material_id, list);
    }
    return m;
  }, [data.uses]);
  const countByKind = useMemo(() => {
    const m = new Map<MaterialKind, number>();
    for (const x of data.materials) m.set(x.kind, (m.get(x.kind) ?? 0) + 1);
    return m;
  }, [data.materials]);
  const visible = kindFilter === 'all' ? data.materials : data.materials.filter(m => m.kind === kindFilter);

  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(`material-${highlightId}`)?.scrollIntoView?.({ block: 'center' });
  }, [highlightId]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ChatActionButton text="帮我写一段“为什么选择我们”" context={{ surface: 'material' }} />
        <ChatActionButton variant="secondary" text="给我一分钟和三分钟两个版本的自我介绍" context={{ surface: 'material' }} />
        <ChatActionButton variant="secondary" text="把我最强的项目写成一个 STAR 故事" context={{ surface: 'material' }} />
        <Button className="ml-auto" variant={creating ? 'ghost' : 'secondary'} onClick={() => setCreating(v => !v)}>{creating ? '收起' : '手动新增'}</Button>
      </div>
      {creating && <CreateForm onDone={() => { setCreating(false); onChanged(); }} />}

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按类型筛选">
        <Chip active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>全部 {data.materials.length}</Chip>
        {MATERIAL_KINDS.map(k => (
          <Chip key={k} active={kindFilter === k} onClick={() => setKindFilter(k)}>{MATERIAL_KIND_LABELS[k]} {countByKind.get(k) ?? 0}</Chip>
        ))}
      </div>

      {data.materials.length === 0 && (
        <EmptyState title="说法库还是空的" hint="助理起草并经你确认的说法会存在这里；网申、邮件、面试里用过的地方都会记录" example="帮我写一段“为什么选择我们”" />
      )}
      {data.materials.length > 0 && visible.length === 0 && <div className="py-6 text-center text-xs text-[var(--subtle)]">这个类型下还没有素材。</div>}
      {visible.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map(m => (
            <MaterialCard key={m.id} material={m} uses={usesByMaterial.get(m.id) ?? []} highlighted={m.id === highlightId} onChanged={onChanged} />
          ))}
        </div>
      )}
    </>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${active ? 'border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]' : 'border-[var(--line)] text-[var(--muted)] hover:border-[var(--primary)] hover:text-[var(--primary)]'}`}
    >
      {children}
    </button>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<MaterialKind>('open_question');
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('');
  const [content, setContent] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const action = useCareerAction();
  const submit = () => action.run(async () => {
    if (!title.trim()) throw new Error('给这段素材起个标题');
    if (!content.trim()) throw new Error('内容不能为空');
    await careerApi.createMaterial({ kind, title: title.trim(), content: content.trim(), company_scope: scope.trim() || null, confirmed });
    onDone();
  });
  return (
    <Card title="手动新增素材">
      {action.error && <ErrorRow message={action.error} />}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="类型">
          <Select ariaLabel="素材类型" value={kind} onChange={v => setKind(v as MaterialKind)} options={KIND_OPTIONS} />
        </Field>
        <Field label="标题">
          <TextInput aria-label="素材标题" placeholder="如：为什么选择字节" value={title} onChange={e => setTitle(e.target.value)} />
        </Field>
        <Field label="只对某家公司（可选）">
          <TextInput aria-label="适用公司" placeholder="留空表示通用" value={scope} onChange={e => setScope(e.target.value)} />
        </Field>
      </div>
      <div className="mt-2">
        <Field label="内容">
          <TextArea aria-label="素材内容" placeholder="写下你确认过的说法" value={content} onChange={e => setContent(e.target.value)} />
        </Field>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button variant={confirmed ? 'primary' : 'secondary'} aria-pressed={confirmed} onClick={() => setConfirmed(v => !v)}>{confirmed ? '已确认' : '标为已确认'}</Button>
        <Button className="ml-auto" variant="primary" busy={action.busy} onClick={() => void submit()}>保存素材</Button>
      </div>
    </Card>
  );
}

function MaterialCard({ material: m, uses, highlighted, onChanged }: { material: Material; uses: MaterialUse[]; highlighted: boolean; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [showUses, setShowUses] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [content, setContent] = useState(m.content);
  const action = useCareerAction();
  const confirmed = m.confirmed === 1 || (m.confirmed as unknown) === true;

  const setConfirmed = (v: boolean) => action.run(async () => { await careerApi.updateMaterial(m.id, { confirmed: v }); onChanged(); });
  const save = () => action.run(async () => {
    if (!title.trim() || !content.trim()) throw new Error('标题和内容不能为空');
    await careerApi.updateMaterial(m.id, { title: title.trim(), content: content.trim() });
    setEditing(false);
    onChanged();
  });
  const remove = () => action.run(async () => {
    if (!window.confirm(`删除「${m.title}」？用过的记录会保留。`)) return;
    await careerApi.deleteMaterial(m.id);
    onChanged();
  });
  const startEdit = () => { setTitle(m.title); setContent(m.content); setEditing(true); };

  return (
    <div id={`material-${m.id}`}>
      <Card
        className={highlighted ? 'ring-2 ring-[var(--primary)]' : ''}
        title={editing ? <TextInput aria-label="编辑标题" value={title} onChange={e => setTitle(e.target.value)} /> : m.title}
        extra={(
          <>
            <Badge tone="accent">{MATERIAL_KIND_LABELS[m.kind] ?? m.kind}</Badge>
            <Badge tone={confirmed ? 'success' : 'neutral'}>{confirmed ? '已确认' : '草稿'}</Badge>
            {m.company_scope && <Badge tone="info">{m.company_scope}</Badge>}
            {m.length_variant && <Badge>{m.length_variant}</Badge>}
          </>
        )}
      >
        {action.error && <ErrorRow message={action.error} />}
        {editing ? (
          <TextArea aria-label="编辑内容" value={content} onChange={e => setContent(e.target.value)} className="min-h-[120px]" />
        ) : (
          <div>
            <div className={`whitespace-pre-wrap break-words text-sm text-[var(--ink)] ${expanded ? '' : 'line-clamp-4'}`}>{m.content}</div>
            {m.content.length > 100 && (
              <button type="button" onClick={() => setExpanded(v => !v)} className="mt-0.5 text-xs text-[var(--primary)] underline-offset-2 hover:underline">{expanded ? '收起' : '展开'}</button>
            )}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
          <button type="button" onClick={() => setShowUses(v => !v)} disabled={uses.length === 0} className="underline-offset-2 hover:underline disabled:no-underline disabled:opacity-70">
            对谁说过（{uses.length}）
          </button>
          <span className="text-[var(--subtle)]">· 更新于 {formatDate(m.updated_at)}</span>
        </div>
        {showUses && uses.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs">
            {uses.map(u => (
              <li key={u.id} className="flex flex-wrap items-center gap-1.5 text-[var(--ink)]">
                <span className="font-medium">{u.company_name ?? '未知公司'}</span>
                <Badge>{u.context}</Badge>
                <span className="text-[var(--subtle)]">{formatDate(u.used_at)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {editing ? (
            <>
              <Button variant="primary" busy={action.busy} onClick={() => void save()}>保存</Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>取消</Button>
            </>
          ) : (
            <>
              <Button variant={confirmed ? 'ghost' : 'secondary'} busy={action.busy} onClick={() => void setConfirmed(!confirmed)}>{confirmed ? '取消确认' : '确认'}</Button>
              <Button variant="ghost" onClick={startEdit}>编辑</Button>
              <Button variant="ghost" busy={action.busy} onClick={() => void remove()}>删除</Button>
              <ChatActionButton className="ml-auto" variant="secondary" text="按这个素材给某公司改一版" context={{ surface: 'material', refs: { material_id: m.id } }} />
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
