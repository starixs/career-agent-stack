/**
 * 岗位收藏：多维表格（R01 校招 / 实习网申汇总，R02 匹配，R06 勾选加入待投清单，R08 导出表格）。
 *
 * 一行一个岗位：公司 / 岗位 / 批次 / 行业 / 类型标签 / 地点 / 截止 / 匹配 / 我的进度 / 链接。点匹配分展开"哪条要求对应你哪段经历"。
 * 筛选只用已有取值做成的选项（批次 / 行业 / 类型 / 地点 / 进度）加一个公司 / 岗位搜索，全部在前端即时算（jobBoardFilters.ts）。
 * 同步 / 导入 / 导出是次要动作，收在工具栏右侧。底部是页面输入框（PageAskBar），旁边是「AI 找工作」入口（功能未上线，先禁用）。
 */
import { ChevronDown, Download, ExternalLink as ExternalLinkIcon, Link2, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ExternalLink } from '@/components/ExternalLink';
import { Popover } from '@/components/ui/Popover';

import { careerApi } from './careerApi';
import { STAGE_LABELS, STAGE_TONES, STAGE_TRANSITIONS } from './careerConstants';
import { PageAskBar } from '@/features/career-shell/PageAskBar';

import { Badge, Button, DueLabel, EmptyState, ErrorRow, LoadingRow, Select, TextInput, textOrUnknown } from './CareerPrimitives';
import {
  DEFAULT_BOARD_FILTER, activeFilterCount, batchLabel, boardAskRefs, facetOptions, filterBoardRows, typeTagsOf,
  type BoardFilterState, type BoardSort, type FacetKey,
} from './jobBoardFilters';
import type { EmploymentType, JobBoardRow, JobPrefs } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

const FACETS: Array<{ key: FacetKey; label: string }> = [
  { key: 'batch', label: '批次' },
  { key: 'industry', label: '行业' },
  { key: 'tag', label: '类型' },
  { key: 'city', label: '地点' },
  { key: 'progress', label: '进度' },
];

const COLUMNS: Array<{ key: string; label: string; className?: string }> = [
  { key: 'company', label: '公司', className: 'w-[148px]' },
  { key: 'title', label: '岗位', className: 'min-w-[200px]' },
  { key: 'batch', label: '批次', className: 'w-[112px]' },
  { key: 'industry', label: '行业', className: 'w-[96px]' },
  { key: 'tag', label: '类型', className: 'w-[120px]' },
  { key: 'city', label: '地点', className: 'w-[120px]' },
  { key: 'deadline', label: '截止', className: 'w-[112px]' },
  { key: 'match', label: '匹配', className: 'w-[72px]' },
  { key: 'progress', label: '我的进度', className: 'w-[148px]' },
  { key: 'link', label: '链接', className: 'w-[64px]' },
];

export function JobBoard({ onChanged, bulkExtra }: { onChanged?: () => void; bulkExtra?: ReactNode }) {
  const [filter, setFilter] = useState<BoardFilterState>(DEFAULT_BOARD_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<'import' | 'prefs' | null>(null);
  // 一次取回全部岗位，筛选在前端算（选项要从全部取值里来）
  const query = useCareerQuery(() => careerApi.jobBoard({}), ['job', 'application', 'action_queue']);
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const rows = useMemo(() => filterBoardRows(allRows, filter), [allRows, filter]);
  const ids = useMemo(() => rows.map(r => r.job.id), [rows]);
  const live = new Set([...selected].filter(id => ids.includes(id)));
  const allChecked = ids.length > 0 && live.size === ids.length;
  const act = useCareerAction();
  const refresh = () => { query.reload(); onChanged?.(); };
  const run = (fn: () => Promise<string | null>) => act.run(async () => { setNotice(await fn()); refresh(); });
  const patch = (p: Partial<BoardFilterState>) => setFilter(f => ({ ...f, ...p }));

  const prepare = () => run(async () => {
    const res = await careerApi.prepareJobs([...live]);
    setSelected(new Set());
    const skipped = (res.results ?? []).filter(r => !r.ok);
    return `已加入待投清单 ${res.queued ?? 0} 个${skipped.length ? `；跳过 ${skipped.length} 个（${[...new Set(skipped.map(s => s.reason))].join('、')}）` : ''}。到通知中心批准后开始填写。`;
  });
  const toggleRow = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏：搜索 + 选项筛选在左，次要动作在右 */}
      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-[var(--subtle)]" strokeWidth={1.75} aria-hidden />
          <TextInput aria-label="搜索岗位" placeholder="搜公司 / 岗位" value={filter.q} onChange={e => patch({ q: e.target.value })} className="!h-8 !w-56 pl-8" />
        </label>
        {FACETS.map(f => (
          <FacetMenu key={f.key} label={f.label} options={facetOptions(allRows, f.key)} selected={filter[f.key] as string[]} onChange={v => patch({ [f.key]: v } as Partial<BoardFilterState>)} />
        ))}
        <ToggleChip pressed={filter.openOnly} onClick={() => patch({ openOnly: !filter.openOnly })}>只看没截止</ToggleChip>
        <ToggleChip pressed={filter.fitsOnly} onClick={() => patch({ fitsOnly: !filter.fitsOnly })}>只看符合我条件</ToggleChip>
        {activeFilterCount(filter) > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setFilter({ ...DEFAULT_BOARD_FILTER, sort: filter.sort, openOnly: filter.openOnly })}><X className="h-3.5 w-3.5" />清除筛选</Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <div className="w-[104px]">
            <Select ariaLabel="排序" value={filter.sort} onChange={v => patch({ sort: v as BoardSort })} options={[{ value: 'match', label: '按匹配' }, { value: 'deadline', label: '按截止' }, { value: 'updated', label: '按更新' }]} />
          </div>
          <Button size="sm" variant="ghost" aria-pressed={panel === 'import'} onClick={() => setPanel(p => (p === 'import' ? null : 'import'))}><Link2 className="h-4 w-4" />导入岗位</Button>
          <IconAction label="同步校招汇总" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.syncJobs('campus'); return `已同步校招汇总 ${r.stored ?? 0} 条，匹配已重算`; })}><RefreshCw className="h-4 w-4" /></IconAction>
          {query.data?.server && <IconAction label="同步服务端岗位库" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.syncJobs('server'); return `已从服务端同步 ${r.stored ?? 0} 条`; })}><RefreshCw className="h-4 w-4" /><span className="text-xs">服务端</span></IconAction>}
          <IconAction label="导出表格" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.exportWorkbook(); return r.path ? `已导出：${r.path}` : '已导出'; })}><Download className="h-4 w-4" /></IconAction>
        </div>
      </div>

      {panel === 'import' && <ImportRow onImported={() => { setPanel(null); refresh(); }} />}

      {/* 状态行：勾选与批量动作在左，我的条件在右 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 pb-2 text-xs text-[var(--muted)]">
        <span className="tabular-nums">{query.data ? `${rows.length} 个岗位${rows.length !== allRows.length ? `（共 ${allRows.length}）` : ''}` : ''}</span>
        {live.size > 0 && <span className="tabular-nums">已选 {live.size}</span>}
        <Button size="sm" variant={live.size > 0 ? 'primary' : 'ghost'} busy={act.busy} disabled={live.size === 0} onClick={() => void prepare()}>加入待投清单（{live.size}）</Button>
        {bulkExtra}
        {query.data && <PrefsSummary prefs={query.data.prefs} editing={panel === 'prefs'} onEdit={() => setPanel(p => (p === 'prefs' ? null : 'prefs'))} />}
      </div>
      {panel === 'prefs' && query.data && <PrefsEditor prefs={query.data.prefs} onDone={() => setPanel(null)} onSaved={() => { setPanel(null); refresh(); }} />}

      <div className="px-6">
        {notice && <div role="status" className="mb-2 text-xs text-[var(--muted)]">{notice}</div>}
        {act.error && <ErrorRow message={act.error} />}
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !query.data && <LoadingRow />}
        {query.data && rows.length === 0 && <EmptyState title="没有符合筛选的岗位" hint="点右上角的同步拉取校招 / 实习网申信息，或放宽筛选。" example="帮我找符合我条件的实习" />}
      </div>

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto px-6">
          <table className="w-full min-w-[1180px] table-fixed border-collapse text-sm">
            <thead className="text-left text-xs text-[var(--muted)] [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--bg)] [&_th]:shadow-[inset_0_-1px_0_var(--line-2)]">
              <tr>
                <th className="w-9 px-2 py-2 font-medium">
                  <input type="checkbox" aria-label="全选岗位" checked={allChecked} ref={el => { if (el) el.indeterminate = live.size > 0 && !allChecked; }} onChange={() => setSelected(allChecked ? new Set() : new Set(ids))} />
                </th>
                {COLUMNS.map(c => <th key={c.key} className={`whitespace-nowrap px-2 py-2 font-medium ${c.className ?? ''}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => <BoardRow key={row.job.id} row={row} checked={live.has(row.job.id)} onToggle={() => toggleRow(row.job.id)} onChanged={refresh} />)}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && <div className="flex-1" />}

      <PageAskBar
        target={{ kind: 'career-dossier', view: 'apply' }}
        refs={boardAskRefs(filter, ids, [...live])}
        placeholder="问问这些岗位，比如「哪些下周截止、适合我」"
        actions={(
          <button
            type="button"
            disabled
            title="AI 找工作即将上线"
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl border-[1.5px] border-[var(--line-2)] bg-[var(--paper)] px-4 text-sm font-semibold text-[var(--subtle)]"
          >
            <Sparkles className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            AI 找工作
          </button>
        )}
      />
    </section>
  );
}

function IconAction({ label, busy, onClick, children }: { label: string; busy?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" variant="ghost" aria-label={label} title={label} busy={busy} onClick={onClick} className="!px-2">{children}</Button>
  );
}

function ToggleChip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex h-8 items-center rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${pressed ? 'border-[var(--primary)] bg-[var(--paper)] font-medium text-[var(--primary)]' : 'border-[var(--line-2)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]'}`}
    >
      {children}
    </button>
  );
}

/** 一个维度的选项筛选：下拉里勾选出现过的取值（多选），不做条件编辑器。 */
function FacetMenu({ label, options, selected, onChange }: { label: string; options: Array<{ value: string; label: string; count: number }>; selected: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const active = selected.length > 0;
  const shown = options.filter(o => selected.includes(o.value)).map(o => o.label);
  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]);
  if (options.length === 0 && !active) return null;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`筛选${label}`}
        onClick={() => setOpen(v => !v)}
        className={`inline-flex h-8 max-w-[220px] items-center gap-1 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${active ? 'border-[var(--primary)] bg-[var(--paper)] font-medium text-[var(--primary)]' : 'border-[var(--line-2)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]'}`}
      >
        <span className="truncate">{active ? `${label}：${shown.join('、')}` : label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} placement="bottom-start" zIndex={50} className="p-1">
        <div role="listbox" aria-label={label} aria-multiselectable className="max-h-72 min-w-[180px] overflow-auto">
          {options.map(o => {
            const on = selected.includes(o.value);
            return (
              <button key={o.value} type="button" role="option" aria-selected={on} onClick={() => toggle(o.value)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--ink)] hover:bg-[var(--hover)]">
                <input type="checkbox" readOnly tabIndex={-1} checked={on} className="pointer-events-none" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="text-xs tabular-nums text-[var(--subtle)]">{o.count}</span>
              </button>
            );
          })}
          {active && (
            <button type="button" onClick={() => { onChange([]); setOpen(false); }} className="mt-1 flex h-8 w-full items-center border-t border-[var(--line)] px-2 text-left text-xs text-[var(--muted)] hover:text-[var(--ink)]">清除{label}</button>
          )}
        </div>
      </Popover>
    </>
  );
}

const TYPE_LABEL: Record<EmploymentType, string> = { campus: '校招', intern: '实习', social: '社招', unknown: '' };

function PrefsSummary({ prefs, editing, onEdit }: { prefs: JobPrefs; editing: boolean; onEdit: () => void }) {
  const summary = [prefs.cohort, prefs.degree, (prefs.cities ?? []).join('/'), (prefs.employment_types ?? []).map(t => TYPE_LABEL[t]).join('/')].filter(Boolean).join(' · ');
  return (
    <span className="ml-auto flex min-w-0 items-center gap-1">
      <span className="truncate" title="匹配按这些条件算；推荐不会违反">{`我的条件：${summary || '还没设置（匹配只看经历，不按届别 / 城市过滤）'}`}</span>
      <Button size="sm" variant="ghost" aria-pressed={editing} onClick={onEdit}>修改</Button>
    </span>
  );
}

function PrefsEditor({ prefs, onDone, onSaved }: { prefs: JobPrefs; onDone: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState({ cohort: prefs.cohort ?? '', degree: prefs.degree ?? '', cities: (prefs.cities ?? []).join('、'), types: prefs.employment_types ?? [] });
  const act = useCareerAction();
  const save = () => act.run(async () => {
    await careerApi.setJobPrefs({ cohort: draft.cohort || null, degree: draft.degree || null, cities: draft.cities.split(/[、,，\s]+/).filter(Boolean), employment_types: draft.types });
    onSaved();
  });
  const toggleType = (t: EmploymentType) => setDraft(d => ({ ...d, types: d.types.includes(t) ? d.types.filter(x => x !== t) : [...d.types, t] }));
  return (
    <div className="mx-6 mb-3 flex flex-wrap items-center gap-2 border-l-2 border-[var(--primary)] py-1 pl-3 text-sm">
      <TextInput aria-label="届别" placeholder="届别，如 2027届" value={draft.cohort} onChange={e => setDraft(d => ({ ...d, cohort: e.target.value }))} className="w-32" />
      <Select ariaLabel="最高学历" value={draft.degree} placeholder="最高学历" onChange={v => setDraft(d => ({ ...d, degree: v }))} options={['大专', '本科', '硕士', '博士'].map(v => ({ value: v, label: v }))} />
      <TextInput aria-label="意向城市" placeholder="意向城市，用顿号分隔" value={draft.cities} onChange={e => setDraft(d => ({ ...d, cities: e.target.value }))} className="w-48" />
      {(['campus', 'intern', 'social'] as const).map(t => (
        <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={draft.types.includes(t)} onChange={() => toggleType(t)} />{TYPE_LABEL[t]}</label>
      ))}
      <Button size="sm" variant="primary" busy={act.busy} onClick={() => void save()}>保存并重算匹配</Button>
      <Button size="sm" variant="ghost" onClick={onDone}>取消</Button>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function ImportRow({ onImported }: { onImported: () => void }) {
  const [url, setUrl] = useState('');
  const act = useCareerAction();
  const doImport = () => act.run(async () => {
    const trimmed = url.trim();
    if (!trimmed) throw new Error('请输入岗位链接或 JD 文本');
    await careerApi.importJob(/^https?:\/\//i.test(trimmed) ? { url: trimmed } : { jd_raw: trimmed, title: trimmed.slice(0, 40), source_platform: 'manual' });
    setUrl('');
    onImported();
  });
  return (
    <div className="mx-6 mb-3 flex max-w-3xl items-center gap-2">
      <Link2 className="h-4 w-4 shrink-0 text-[var(--muted)]" />
      <TextInput autoFocus aria-label="导入岗位链接" placeholder="粘贴岗位链接（或 JD 文本）后回车导入" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void doImport(); }} />
      <Button busy={act.busy} onClick={() => void doImport()}>导入岗位链接</Button>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function Pill({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--inset)] px-2 text-xs text-[var(--ink-2)]">{children}</span>;
}

const CELL = 'truncate px-2 py-2';

function BoardRow({ row, checked, onToggle, onChanged }: { row: JobBoardRow; checked: boolean; onToggle: () => void; onChanged: () => void }) {
  const { job, match, application } = row;
  const [open, setOpen] = useState(false);
  const stageAction = useCareerAction();
  const targets = application ? STAGE_TRANSITIONS[application.stage] ?? [] : [];
  const changeStage = (to: string) => stageAction.run(async () => { if (application && to) { await careerApi.setStage(application.id, to); onChanged(); } });
  const tags = typeTagsOf(row);
  const batch = batchLabel(row);
  const company = textOrUnknown(job.company_name);
  return (
    <>
      <tr className={`group border-b border-[var(--line)] transition-colors hover:bg-[var(--hover)] ${checked ? 'bg-[var(--selected)]' : ''} ${job.source_status === 'closed' ? 'text-[var(--subtle)]' : ''}`}>
        <td className="px-2 py-2"><input type="checkbox" aria-label={`选择岗位 ${job.title}`} checked={checked} onChange={onToggle} /></td>
        <td className={`${CELL} font-medium text-[var(--ink)]`} title={company}>{company}</td>
        <td className={`${CELL} text-[var(--ink-2)]`} title={job.title}>
          {job.title}{job.source_status === 'closed' && <span className="ml-1 text-[var(--subtle)]">（已下架）</span>}
        </td>
        <td className={`${CELL} text-[var(--muted)]`} title={batch}>{batch || <Dash />}</td>
        <td className={`${CELL} text-[var(--muted)]`} title={row.meta?.industry ?? undefined}>{row.meta?.industry ?? <Dash />}</td>
        <td className="px-2 py-2">
          {tags.length ? <span className="flex gap-1 overflow-hidden" title={tags.join('、')}>{tags.map(t => <Pill key={t}>{t}</Pill>)}</span> : <Dash />}
        </td>
        <td className={`${CELL} text-[var(--muted)]`} title={job.location ?? undefined}>{job.location ?? <Dash />}</td>
        <td className="whitespace-nowrap px-2 py-2 text-xs">
          <DueLabel at={job.deadline} suffix="" />
          {job.deadline && !job.deadline_verified_at && <span className="ml-1 text-[var(--subtle)]" title="截止日期来自汇总数据，还没到官网核实">未核实</span>}
        </td>
        <td className="px-2 py-2">
          {match ? (
            <button type="button" className="flex items-center gap-1 text-left" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={`匹配详情 ${job.title}`}>
              <span className={`tabular-nums ${!match.hard_ok ? 'text-[var(--muted)]' : match.score >= 70 ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-2)]'}`}>{match.hard_ok ? match.score : '不符合'}</span>
              <span className="text-xs tabular-nums text-[var(--muted)]">{match.covered}/{match.total}</span>
            </button>
          ) : <span className="text-xs text-[var(--subtle)]">未计算</span>}
        </td>
        <td className="px-2 py-1.5">
          {application ? (
            <div className="flex items-center gap-1">
              <Badge tone={STAGE_TONES[application.stage] ?? 'neutral'}>{STAGE_LABELS[application.stage] ?? application.stage}</Badge>
              {targets.length > 0 && (
                <div className="w-[76px] opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <Select ariaLabel={`切换阶段 ${job.title}`} value="" placeholder="改为…" disabled={stageAction.busy} onChange={v => void changeStage(v)} options={targets.map(t => ({ value: t, label: STAGE_LABELS[t] ?? t }))} />
                </div>
              )}
            </div>
          ) : <span className="text-xs text-[var(--subtle)]">未投递</span>}
          {stageAction.error && <div role="alert" className="text-xs text-[var(--danger)]">{stageAction.error}</div>}
        </td>
        <td className="px-2 py-2">
          {job.url
            ? <ExternalLink href={job.url} title={`打开网申页面：${job.url}`} className="inline-flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"><ExternalLinkIcon className="h-3.5 w-3.5" strokeWidth={1.75} />网申</ExternalLink>
            : <Dash />}
        </td>
      </tr>
      {open && match && (
        <tr className="border-b border-[var(--line)] bg-[var(--inset)]">
          <td />
          <td colSpan={COLUMNS.length} className="px-2 py-2 text-xs">
            <div className="mb-1 text-[var(--ink)]">{match.summary}</div>
            {match.hard.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-2">
                {match.hard.map(h => <span key={h.rule} className={h.ok === false ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}>{h.label}：{h.detail}</span>)}
              </div>
            )}
            <ul className="space-y-0.5">
              {match.requirements.map((r, i) => (
                <li key={`${r.requirement}-${i}`}>
                  <Badge tone={r.status === 'covered' ? 'success' : 'neutral'}>{r.status === 'covered' ? '有经历' : '暂无证据'}</Badge>
                  <span className="ml-1.5 text-[var(--ink)]">{r.requirement}</span>
                  {r.evidence && <span className="ml-1.5 text-[var(--muted)]">← {r.evidence.label ? `${r.evidence.label}：` : ''}「{r.evidence.text}」</span>}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

function Dash() {
  return <span className="text-[var(--subtle)]">—</span>;
}

