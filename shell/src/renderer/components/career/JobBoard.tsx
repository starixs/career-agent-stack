/**
 * 岗位库：多维表格（R01 校招 / 实习网申汇总，R02 匹配，R06 框选一批确认投出，R08 导出表格）。
 *
 * 一行一个岗位：公司 / 岗位 / 批次 / 行业 / 类型标签 / 地点 / 截止 / 匹配 / 我的进度 / 链接。点匹配分展开"哪条要求对应你哪段经历"。
 * 筛选只用已有取值做成的选项（批次 / 行业 / 类型 / 地点 / 进度）加一个公司 / 岗位搜索，全部在前端即时算（jobBoardFilters.ts）。
 * 同步 / 导入 / 导出是次要动作，收在工具栏右侧。勾选后「投这 N 家」一次确认就开始（JobBoardApply.tsx），
 * 底部输入框上沿是和对话同一条等你条；输入框旁边是「AI 找工作」入口（功能未上线，先禁用）。
 */
import { ChevronDown, Download, ExternalLink as ExternalLinkIcon, Link2, RefreshCw, Search, X } from 'lucide-react';
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
import { WaitingDock } from './delivery/WaitingDock';
import { ApplyConfirm } from './JobBoardApply';
import { TargetStar } from './TargetStar';
import { useRangeSelect } from './useRangeSelect';
import type { EmploymentType, Job, JobBoardRow, JobPrefs } from './types';
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
  { key: 'link', label: '链接', className: 'w-[80px]' },
];

/** `confirmExtra`：放进「投这 N 家」确认区的控件（比如「检查都过了就直接投出」），浏览时不出现。 */
export function JobBoard({ onChanged, confirmExtra }: { onChanged?: () => void; confirmExtra?: ReactNode }) {
  const [filter, setFilter] = useState<BoardFilterState>(DEFAULT_BOARD_FILTER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<'import' | 'prefs' | 'apply' | null>(null);
  // 一次取回全部岗位，筛选在前端算（选项要从全部取值里来）
  const query = useCareerQuery(() => careerApi.jobBoard({}), ['job', 'application', 'action_queue']);
  const allRows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const rows = useMemo(() => filterBoardRows(allRows, filter), [allRows, filter]);
  const ids = useMemo(() => rows.map(r => r.job.id), [rows]);
  // 勾选跨搜索保留：学生常常搜一家勾一家，凑成一批再投（2026-10-31 实例测试：换个搜索词前面勾的就没了）。
  // 只丢掉库里已经不存在的岗位；当前列表里看得见几个单独算，表头全选只管看得见的这些。
  const allIds = useMemo(() => new Set(allRows.map(r => r.job.id)), [allRows]);
  const picked = [...selected].filter(id => allIds.has(id));
  const visiblePicked = ids.filter(id => selected.has(id)).length;
  const hiddenPicked = picked.length - visiblePicked;
  const allChecked = ids.length > 0 && visiblePicked === ids.length;
  const toggleAllVisible = () => {
    const next = new Set(selected);
    for (const id of ids) { if (allChecked) next.delete(id); else next.add(id); }
    setSelected(next);
  };
  const act = useCareerAction();
  const refresh = () => { query.reload(); onChanged?.(); };
  const run = (fn: () => Promise<string | null>) => act.run(async () => { setNotice(await fn()); refresh(); });
  const patch = (p: Partial<BoardFilterState>) => setFilter(f => ({ ...f, ...p }));

  const started = (msg: string) => { setNotice(msg); setSelected(new Set()); setPanel(null); refresh(); };
  const pick = useRangeSelect(ids, selected, setSelected);
  // 匹配分整列一样时没有区分度：不占一列，展开详情仍可从岗位行进
  const showMatch = useMemo(() => new Set(rows.map(r => (r.match ? `${r.match.hard_ok}:${r.match.score}` : 'none'))).size > 1, [rows]);
  const columns = showMatch ? COLUMNS : COLUMNS.filter(c => c.key !== 'match');

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
          <IconAction label="同步校招汇总" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.syncJobs('campus'); return `岗位库更新了 ${r.stored ?? 0} 条`; })}><RefreshCw className="h-4 w-4" /></IconAction>
          {query.data?.server && <IconAction label="同步服务端岗位库" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.syncJobs('server'); return `已从服务端同步 ${r.stored ?? 0} 条`; })}><RefreshCw className="h-4 w-4" /><span className="text-xs">服务端</span></IconAction>}
          <IconAction label="导出表格" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.exportWorkbook(); return r.path ? `已导出：${r.path}` : '已导出'; })}><Download className="h-4 w-4" /></IconAction>
        </div>
      </div>

      {panel === 'import' && <ImportRow onImported={() => { setPanel(null); refresh(); }} />}

      {/* 状态行：岗位数 + 我的条件；勾了才出现「投这 N 家」 */}
      <div className="flex min-h-[30px] flex-wrap items-center gap-x-3 gap-y-1 px-6 pb-2 text-xs text-[var(--muted)]">
        <span className="tabular-nums">{query.data ? `${rows.length} 个岗位${rows.length !== allRows.length ? `（共 ${allRows.length}）` : ''}` : ''}</span>
        {picked.length > 0 && (
          <>
            {hiddenPicked > 0 && <span className="tabular-nums">另有 {hiddenPicked} 个在别的搜索里</span>}
            <Button size="sm" variant="primary" aria-pressed={panel === 'apply'} onClick={() => setPanel(p => (p === 'apply' ? null : 'apply'))}>投这 {picked.length} 家</Button>
          </>
        )}
        {query.data && <PrefsSummary prefs={query.data.prefs} editing={panel === 'prefs'} onEdit={() => setPanel(p => (p === 'prefs' ? null : 'prefs'))} />}
      </div>
      {panel === 'apply' && picked.length > 0 && <ApplyConfirm jobIds={picked} extra={confirmExtra} onStarted={started} onCancel={() => setPanel(null)} />}
      {panel === 'prefs' && query.data && <PrefsEditor prefs={query.data.prefs} onDone={() => setPanel(null)} onSaved={() => { setPanel(null); refresh(); }} />}

      <div className="px-6">
        {notice && <div role="status" className="mb-2 text-xs text-[var(--muted)]">{notice}</div>}
        {act.error && <ErrorRow message={act.error} />}
        {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
        {query.loading && !query.data && <LoadingRow />}
        {query.data && rows.length === 0 && (allRows.length === 0
          ? <EmptyState title="岗位正在更新" />
          : <EmptyState title="没有符合筛选的岗位" action={<Button variant="secondary" onClick={() => setFilter(DEFAULT_BOARD_FILTER)}>清除筛选</Button>} />)}
      </div>

      {rows.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto px-6">
          <table className="w-full min-w-[1180px] table-fixed border-collapse text-sm">
            <thead className="text-left text-xs text-[var(--muted)] [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--bg)] [&_th]:shadow-[inset_0_-1px_0_var(--line-2)]">
              <tr>
                <th className="w-9 px-2 py-2 font-medium">
                  <input type="checkbox" aria-label="全选岗位" checked={allChecked} ref={el => { if (el) el.indeterminate = visiblePicked > 0 && !allChecked; }} onChange={toggleAllVisible} />
                </th>
                {columns.map(c => <th key={c.key} className={`whitespace-nowrap px-2 py-2 font-medium ${c.className ?? ''}`}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => <BoardRow key={row.job.id} row={row} showMatch={showMatch} checked={selected.has(row.job.id)} pick={pick} onChanged={refresh} />)}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 0 && <div className="flex-1" />}

      {/* 和对话里同一条等你条（同一批事，处理一处处处生效）：投出去以后要你登录、补信息、一键投出都在这里，不用翻页去找 */}
      <div className="flex justify-center px-6 pt-2"><WaitingDock /></div>

      <PageAskBar
        target={{ kind: 'career-dossier', view: 'apply' }}
        refs={boardAskRefs(filter, ids, picked)}
        placeholder="问问这些岗位，比如「哪些下周截止、适合我」"
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
      <span className="truncate">{`我的条件：${summary || '还没设置'}`}</span>
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

const CELL = 'truncate px-2 py-2';

function BoardRow({ row, showMatch, checked, pick, onChanged }: { row: JobBoardRow; showMatch: boolean; checked: boolean; pick: ReturnType<typeof useRangeSelect>; onChanged: () => void }) {
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
        {/* 勾选列可框选：Shift + 点选一段，按住拖过几行一起勾 */}
        <td className="cursor-pointer select-none px-2 py-2" onMouseDown={() => pick.pressStart(job.id)} onMouseEnter={() => pick.dragOver(job.id)}>
          <input type="checkbox" aria-label={`选择岗位 ${job.title}`} checked={checked} readOnly onClick={e => pick.click(job.id, e.shiftKey)} />
        </td>
        <td className={`${CELL} font-medium text-[var(--ink)]`} title={company}>
          <span className="flex min-w-0 items-center gap-1"><TargetStar jobId={job.id} source={row.target} label={`${company} ${job.title}`} onChanged={onChanged} /><span className="truncate">{company}</span></span>
        </td>
        <td className={`${CELL} text-[var(--ink-2)]`} title={job.title}>
          {match && !showMatch
            ? <button type="button" className="truncate text-left hover:underline" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={`匹配详情 ${job.title}`}>{job.title}</button>
            : job.title}
          {job.source_status === 'closed' && <span className="ml-1 text-[var(--subtle)]">（已下架）</span>}
        </td>
        <td className={`${CELL} text-[var(--muted)]`} title={batch}>{batch || <Dash />}</td>
        <td className={`${CELL} text-[var(--muted)]`} title={row.meta?.industry ?? undefined}>{row.meta?.industry ?? <Dash />}</td>
        <td className={`${CELL} text-[var(--muted)]`} title={tags.join('、') || undefined}>{tags.length ? tags.join(' · ') : <Dash />}</td>
        <td className={`${CELL} text-[var(--muted)]`} title={job.location ?? undefined}>{job.location ?? <Dash />}</td>
        <td className="whitespace-nowrap px-2 py-2 text-xs" title={job.deadline && !job.deadline_verified_at ? '截止日期来自汇总数据，还没到官网核实' : undefined}>
          <DueLabel at={job.deadline} suffix="" />
        </td>
        {showMatch && <td className="px-2 py-2">
          {match ? (
            <button type="button" className="flex items-center gap-1 text-left" title={`要求覆盖 ${match.covered}/${match.total}`} onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={`匹配详情 ${job.title}`}>
              <span className={`tabular-nums ${!match.hard_ok ? 'text-[var(--muted)]' : match.score >= 70 ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-2)]'}`}>{match.hard_ok ? match.score : '不符合'}</span>
            </button>
          ) : <Dash />}
        </td>}
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
          <ApplyChannelCell job={job} />
        </td>
      </tr>
      {open && match && (
        <tr className="border-b border-[var(--line)] bg-[var(--inset)]">
          <td />
          <td colSpan={showMatch ? COLUMNS.length : COLUMNS.length - 1} className="px-2 py-2 text-xs">
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

/**
 * 投递方式那一格：JD 写了投递邮箱的走邮件投递（服务端 applyChannelOf：有邮箱就是邮件），「投这 N 家」照样能选；
 * 只收邮件的岗位没有网申链接，这一格不出空链接（R5：岗位库收只有投递邮箱的岗位）。
 */
export function ApplyChannelCell({ job }: { job: Pick<Job, 'url' | 'apply_email'> }) {
  // 逐页 UX 收口后岗位库不用小胶囊（标签一格也是纯字），这里同样只写字
  if (job.apply_email) return <span className="text-xs text-[var(--muted)]">邮件投递</span>;
  if (!job.url) return <Dash />;
  return <ExternalLink href={job.url} title={`打开网申页面：${job.url}`} className="inline-flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"><ExternalLinkIcon className="h-3.5 w-3.5" strokeWidth={1.75} />网申</ExternalLink>;
}

function Dash() {
  return <span className="text-[var(--subtle)]">—</span>;
}

