/**
 * 几家一起投时，网申现场顶上的一排公司小签：点一家，画面和你的操作就落在那一家的页面上。
 * 只有一家开着页面时不出现（用户 2026-11-02：「投 3 家，实际上只能看到美团这一家」）。
 * 在等你的几家排前面、带「等你」：哪家要你接手就点过去在那家处理，交还也只交那一家，别的照常填（2026-11-03）。
 */
import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import CustomSelect from '@/components/CustomSelect';

import { HANDOFF_REASON_LABELS } from './careerConstants';
import { useCareerQuery } from './useCareerData';

export interface LivePage { application_id: string; company: string; title: string; current: boolean; waiting: string | null }

/** 跨边界数据先过一遍：只认字段齐全的那几项。 */
export function parseLivePages(raw: unknown): LivePage[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { pages?: unknown }).pages) ? (raw as { pages: unknown[] }).pages : [];
  return list.flatMap(p => {
    if (!p || typeof p !== 'object') return [];
    const { application_id: id, company, title, current, waiting } = p as Record<string, unknown>;
    return typeof id === 'string' && typeof company === 'string'
      ? [{ application_id: id, company, title: typeof title === 'string' ? title : '', current: current === true, waiting: typeof waiting === 'string' && waiting ? waiting : null }]
      : [];
  });
}

export function LivePageTabs() {
  const { data, reload } = useCareerQuery(async () => parseLivePages(await apiGetJson<unknown>('/api/career/live/pages')), ['action_queue', 'handoff']);
  const pages = data ?? [];
  if (pages.length < 2) return null;
  const show = (id: string) => {
    void apiPostJson<unknown>('/api/career/live/view', { application_id: id })
      .then(reload, (e: unknown) => { console.error('[career-live] 切换现场 FAILED', id, e); reload(); });
  };
  if (pages.length > 4) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-5 py-2" data-testid="live-page-tabs">
        <span className="shrink-0 text-xs text-[var(--muted)]">正在投 {pages.length} 份</span>
        <CustomSelect
          ariaLabel="选择网申任务"
          placeholder="选一份看"
          className="min-w-0 flex-1"
          size="toolbar"
          value={pages.find(p => p.current)?.application_id ?? ''}
          options={pages.map(p => ({ value: p.application_id, label: `${p.company} · ${p.title}${p.waiting ? ' · 等你' : ''}` }))}
          onChange={show}
        />
      </div>
    );
  }
  return (
    <div role="tablist" aria-label="正在投的几家" className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-[var(--line)] px-5 py-2" data-testid="live-page-tabs">
      {pages.map(p => (
        <button key={p.application_id} type="button" role="tab" aria-selected={p.current} onClick={() => show(p.application_id)}
          title={`${p.company} · ${p.title}${p.waiting ? ` · 等你：${HANDOFF_REASON_LABELS[p.waiting] ?? p.waiting}` : ''}`}
          className={`shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${p.current
            ? 'border-[var(--ink)] bg-[var(--paper)] font-semibold text-[var(--ink)]'
            : 'border-[var(--line-2)] text-[var(--muted)] hover:bg-[var(--hover)]'}`}>
          {p.company}
          {p.waiting && <span className="ml-1.5 text-[var(--warning)]">· 等你</span>}
        </button>
      ))}
    </div>
  );
}
