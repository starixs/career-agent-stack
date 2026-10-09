/**
 * 岗位汇总表（R01 校招 / 实习网申汇总，R02 匹配，R06 勾选 / 全选加入待投清单，R08 导出表格）。
 *
 * 一行一个岗位：公司 / 岗位 / 类型 / 届别 / 地点 / 截止 / 匹配 / 我的进度。点匹配分展开"哪条要求对应你哪段经历"。
 * 顶部是我的求职条件（硬条件，推荐不违反）与筛选；勾选后"加入待投清单"会冻结材料包并进入待审。
 */
import { Download, Link2, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ExternalLink } from '@/components/ExternalLink';

import { careerApi } from './careerApi';
import { STAGE_LABELS, STAGE_TRANSITIONS } from './careerConstants';
import { Badge, Button, EmptyState, ErrorRow, LoadingRow, SectionTitle, Select, TextInput, formatDate, textOrUnknown, type BadgeTone } from './CareerPrimitives';
import type { ApplicationStage, EmploymentType, JobBoardFilter, JobBoardRow, JobPrefs } from './types';
import { useCareerAction, useCareerQuery } from './useCareerData';

const TYPE_LABEL: Record<EmploymentType, string> = { campus: '校招', intern: '实习', social: '社招', unknown: '' };
const STAGE_TONE: Partial<Record<ApplicationStage, BadgeTone>> = { blocked: 'error', needs_user: 'warning', offer: 'success', hired: 'success', interview: 'info', applied: 'info', rejected: 'neutral', discarded: 'neutral' };

export function JobBoard({ onChanged }: { onChanged?: () => void }) {
  const [filter, setFilter] = useState<JobBoardFilter>({ open_only: true, sort: 'match' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const query = useCareerQuery(() => careerApi.jobBoard(filter), ['job', 'application', 'action_queue']);
  // useCareerQuery 不随参数重取：筛选变化时手动 reload
  // 同一次渲染里先同步 fetcher（useCareerQuery 的 ref effect 在取数 effect 之前），再按新筛选取数
  const update = (patch: JobBoardFilter) => { setFilter(f => ({ ...f, ...patch })); query.reload(); };
  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const ids = useMemo(() => rows.map(r => r.job.id), [rows]);
  const live = new Set([...selected].filter(id => ids.includes(id)));
  const allChecked = ids.length > 0 && live.size === ids.length;
  const act = useCareerAction();
  const run = (fn: () => Promise<string | null>) => act.run(async () => { setNotice(await fn()); query.reload(); onChanged?.(); });

  const prepare = () => run(async () => {
    const res = await careerApi.prepareJobs([...live]);
    setSelected(new Set());
    const skipped = (res.results ?? []).filter(r => !r.ok);
    return `已加入待投清单 ${res.queued ?? 0} 个${skipped.length ? `；跳过 ${skipped.length} 个（${[...new Set(skipped.map(s => s.reason))].join('、')}）` : ''}。在上面的待投清单里勾选批准后开始填写。`;
  });

  return (
    <section>
      <SectionTitle extra={(
        <>
          <Button size="sm" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.syncJobs('campus'); return `已同步校招汇总 ${r.stored ?? 0} 条，匹配已重算`; })}><RefreshCw className="h-3.5 w-3.5" />同步校招汇总</Button>
          {query.data?.server && <Button size="sm" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.syncJobs('server'); return `已从服务端同步 ${r.stored ?? 0} 条`; })}><RefreshCw className="h-3.5 w-3.5" />同步服务端岗位库</Button>}
          <Button size="sm" busy={act.busy} onClick={() => void run(async () => { const r = await careerApi.exportWorkbook(); return r.path ? `已导出：${r.path}` : '已导出'; })}><Download className="h-3.5 w-3.5" />导出表格</Button>
        </>
      )}>
        岗位汇总表（{rows.length}）
      </SectionTitle>
      {query.data && <PrefsBar prefs={query.data.prefs} onSaved={() => { query.reload(); onChanged?.(); }} />}
      <FilterBar filter={filter} onChange={update} />
      <ImportRow onImported={() => { query.reload(); onChanged?.(); }} />
      {notice && <div role="status" className="mb-2 text-xs text-[var(--muted)]">{notice}</div>}
      {act.error && <ErrorRow message={act.error} />}
      {query.error && <ErrorRow message={query.error} onRetry={query.reload} />}
      {query.loading && !query.data && <LoadingRow />}
      {query.data && rows.length === 0 && <EmptyState title="没有符合筛选的岗位" hint="点「同步校招汇总」拉取校招 / 实习网申信息，或放宽筛选。" example="帮我找符合我条件的实习" />}
      {rows.length > 0 && (
        <>
          <div className="mb-1.5 flex items-center gap-3 text-xs text-[var(--muted)]">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" aria-label="全选岗位" checked={allChecked} ref={el => { if (el) el.indeterminate = live.size > 0 && !allChecked; }} onChange={() => setSelected(allChecked ? new Set() : new Set(ids))} />
              全选（{live.size} / {ids.length}）
            </label>
            <Button size="sm" variant="primary" busy={act.busy} disabled={live.size === 0} onClick={() => void prepare()}>加入待投清单（{live.size}）</Button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
            <table className="w-full min-w-[960px] border-collapse text-xs">
              <thead className="bg-[var(--inset)] text-left text-[var(--muted)]">
                <tr>{['', '公司', '岗位', '类型', '届别', '地点', '截止', '匹配', '我的进度', '页面'].map(h => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <BoardRow key={row.job.id} row={row} checked={live.has(row.job.id)} onToggle={() => setSelected(prev => { const n = new Set(prev); if (n.has(row.job.id)) n.delete(row.job.id); else n.add(row.job.id); return n; })} onChanged={() => { query.reload(); onChanged?.(); }} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function PrefsBar({ prefs, onSaved }: { prefs: JobPrefs; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ cohort: prefs.cohort ?? '', degree: prefs.degree ?? '', cities: (prefs.cities ?? []).join('、'), types: prefs.employment_types ?? [] });
  const act = useCareerAction();
  const save = () => act.run(async () => {
    await careerApi.setJobPrefs({ cohort: draft.cohort || null, degree: draft.degree || null, cities: draft.cities.split(/[、,，\s]+/).filter(Boolean), employment_types: draft.types });
    setEditing(false); onSaved();
  });
  const summary = [prefs.cohort, prefs.degree, (prefs.cities ?? []).join('/'), (prefs.employment_types ?? []).map(t => TYPE_LABEL[t]).join('/')].filter(Boolean).join(' · ');
  if (!editing) {
    return (
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        <span>我的条件：{summary || '还没设置（匹配只看经历，不按届别 / 城市过滤）'}</span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>修改</Button>
      </div>
    );
  }
  const toggleType = (t: EmploymentType) => setDraft(d => ({ ...d, types: d.types.includes(t) ? d.types.filter(x => x !== t) : [...d.types, t] }));
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-xs">
      <TextInput aria-label="届别" placeholder="届别，如 2027届" value={draft.cohort} onChange={e => setDraft(d => ({ ...d, cohort: e.target.value }))} className="w-32" />
      <Select ariaLabel="最高学历" value={draft.degree} placeholder="最高学历" onChange={v => setDraft(d => ({ ...d, degree: v }))} options={['大专', '本科', '硕士', '博士'].map(v => ({ value: v, label: v }))} />
      <TextInput aria-label="意向城市" placeholder="意向城市，用顿号分隔" value={draft.cities} onChange={e => setDraft(d => ({ ...d, cities: e.target.value }))} className="w-48" />
      {(['campus', 'intern', 'social'] as const).map(t => (
        <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={draft.types.includes(t)} onChange={() => toggleType(t)} />{TYPE_LABEL[t]}</label>
      ))}
      <Button size="sm" variant="primary" busy={act.busy} onClick={() => void save()}>保存并重算匹配</Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function FilterBar({ filter, onChange }: { filter: JobBoardFilter; onChange: (p: JobBoardFilter) => void }) {
  const [q, setQ] = useState(filter.q ?? '');
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
      <TextInput aria-label="搜索岗位" placeholder="搜公司 / 岗位 / 地点" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onChange({ q }); }} className="w-48" />
      <Select ariaLabel="类型" value={filter.employment_type ?? ''} placeholder="全部类型" onChange={v => onChange({ employment_type: v || undefined })} options={[{ value: '', label: '全部类型' }, { value: 'campus', label: '校招' }, { value: 'intern', label: '实习' }, { value: 'social', label: '社招' }]} />
      <Select ariaLabel="进度" value={filter.progress ?? ''} placeholder="全部进度" onChange={v => onChange({ progress: (v || undefined) as JobBoardFilter['progress'] })} options={[{ value: '', label: '全部进度' }, { value: 'none', label: '未投递' }, { value: 'active', label: '进行中' }, { value: 'done', label: '已投出' }]} />
      <Select ariaLabel="排序" value={filter.sort ?? 'match'} onChange={v => onChange({ sort: v as JobBoardFilter['sort'] })} options={[{ value: 'match', label: '按匹配' }, { value: 'deadline', label: '按截止' }, { value: 'updated', label: '按更新' }]} />
      <label className="flex items-center gap-1 text-[var(--muted)]"><input type="checkbox" checked={!!filter.open_only} onChange={e => onChange({ open_only: e.target.checked })} />只看没截止</label>
      <label className="flex items-center gap-1 text-[var(--muted)]"><input type="checkbox" checked={!!filter.fits_only} onChange={e => onChange({ fits_only: e.target.checked })} />只看符合我条件</label>
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
    <div className="mb-3 flex items-center gap-2">
      <Link2 className="h-4 w-4 shrink-0 text-[var(--muted)]" />
      <TextInput aria-label="导入岗位链接" placeholder="粘贴岗位链接（或 JD 文本）后回车导入" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void doImport(); }} />
      <Button variant="primary" busy={act.busy} onClick={() => void doImport()}>导入岗位链接</Button>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

function BoardRow({ row, checked, onToggle, onChanged }: { row: JobBoardRow; checked: boolean; onToggle: () => void; onChanged: () => void }) {
  const { job, match, application } = row;
  const [open, setOpen] = useState(false);
  const stageAction = useCareerAction();
  const targets = application ? STAGE_TRANSITIONS[application.stage] ?? [] : [];
  const changeStage = (to: string) => stageAction.run(async () => { if (application && to) { await careerApi.setStage(application.id, to); onChanged(); } });
  const pageUrl = job.url;
  return (
    <>
      <tr className="border-t border-[var(--line)] align-top">
        <td className="px-2 py-1.5"><input type="checkbox" aria-label={`选择岗位 ${job.title}`} checked={checked} onChange={onToggle} /></td>
        <td className="px-2 py-1.5 text-[var(--ink)]">{textOrUnknown(job.company_name)}</td>
        <td className="px-2 py-1.5 font-medium text-[var(--ink)]">{job.title}{job.source_status === 'closed' && <span className="ml-1 text-[var(--subtle)]">（已下架）</span>}</td>
        <td className="px-2 py-1.5 text-[var(--muted)]">{TYPE_LABEL[job.employment_type ?? 'unknown']}</td>
        <td className="px-2 py-1.5 text-[var(--muted)]">{job.cohort ?? ''}</td>
        <td className="px-2 py-1.5 text-[var(--muted)]">{textOrUnknown(job.location)}</td>
        <td className="px-2 py-1.5 text-[var(--muted)]">{formatDate(job.deadline)}{job.deadline && !job.deadline_verified_at && <span className="ml-1 text-[var(--subtle)]">（未核实）</span>}</td>
        <td className="px-2 py-1.5">
          {match ? (
            <button type="button" className="flex items-center gap-1 text-left" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={`匹配详情 ${job.title}`}>
              <Badge tone={!match.hard_ok ? 'neutral' : match.score >= 70 ? 'success' : match.score >= 50 ? 'info' : 'warning'}>{match.hard_ok ? match.score : '不符合'}</Badge>
              <span className="text-[var(--muted)]">{match.covered}/{match.total}</span>
            </button>
          ) : <span className="text-[var(--subtle)]">未计算</span>}
        </td>
        <td className="px-2 py-1.5">
          {application ? (
            <div className="flex flex-col gap-1">
              <Badge tone={STAGE_TONE[application.stage] ?? 'neutral'}>{STAGE_LABELS[application.stage] ?? application.stage}</Badge>
              {targets.length > 0 && <Select ariaLabel={`切换阶段 ${job.title}`} value="" placeholder="改为…" disabled={stageAction.busy} onChange={v => void changeStage(v)} options={targets.map(t => ({ value: t, label: STAGE_LABELS[t] ?? t }))} />}
              {stageAction.error && <span role="alert" className="text-[var(--danger)]">{stageAction.error}</span>}
            </div>
          ) : <span className="text-[var(--subtle)]">未投递</span>}
        </td>
        <td className="px-2 py-1.5">{pageUrl ? <ExternalLink href={pageUrl} className="text-[var(--primary)] underline underline-offset-2">打开</ExternalLink> : <span className="text-[var(--subtle)]">—</span>}</td>
      </tr>
      {open && match && (
        <tr className="bg-[var(--inset)]">
          <td />
          <td colSpan={9} className="px-2 py-2 text-xs">
            <div className="mb-1 text-[var(--ink)]">{match.summary}</div>
            {match.hard.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-2">
                {match.hard.map(h => <span key={h.rule} className={h.ok === false ? 'text-[var(--danger)]' : h.ok === null ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}>{h.label}：{h.detail}</span>)}
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
