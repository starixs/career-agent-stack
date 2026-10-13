/**
 * 岗位收藏多维表格的筛选：选项全部来自已有数据里出现过的取值（批次 / 行业 / 类型标签 / 地点 / 进度），
 * 再加一个全局搜索（公司 / 岗位）。不做「等于 / 包含」条件编辑器。全部在前端算：一次取回全部岗位，筛选即时生效。
 */
import type { JobBoardRow } from './types';

export type BoardSort = 'match' | 'deadline' | 'updated';
export type ProgressKey = 'none' | 'active' | 'done';
export type FacetKey = 'batch' | 'industry' | 'tag' | 'city' | 'progress';

export interface BoardFilterState {
  q: string;
  batch: string[]; industry: string[]; tag: string[]; city: string[]; progress: ProgressKey[];
  openOnly: boolean; fitsOnly: boolean; sort: BoardSort;
}

export const DEFAULT_BOARD_FILTER: BoardFilterState = {
  q: '', batch: [], industry: [], tag: [], city: [], progress: [], openOnly: true, fitsOnly: false, sort: 'match',
};

export const EMPLOYMENT_LABELS: Record<string, string> = { campus: '校招', intern: '实习', social: '社招' };
export const PROGRESS_LABELS: Record<ProgressKey, string> = { none: '未投递', active: '进行中', done: '已投出' };

/** 与 server job-board.ts 的 DONE 一致：投出去之后的阶段。 */
const DONE_STAGES: ReadonlySet<string> = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'hired', 'skip']);

export function progressOf(row: JobBoardRow): ProgressKey {
  if (!row.application) return 'none';
  return DONE_STAGES.has(row.application.stage) ? 'done' : 'active';
}

/** 类型标签：校招 / 实习 / 社招 + 来源里的企业性质（央国企、外企…）。 */
export function typeTagsOf(row: JobBoardRow): string[] {
  const out: string[] = [];
  const emp = EMPLOYMENT_LABELS[row.job.employment_type ?? ''];
  if (emp) out.push(emp);
  for (const t of row.meta?.type_tags ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

export function citiesOf(row: JobBoardRow): string[] {
  return (row.job.location ?? '').split(/[/、,，;；|\s]+/).map(s => s.trim()).filter(Boolean);
}

/** 2027届 → 27届；批次和届别合起来显示，如「27届 · 正式批」。 */
export function batchLabel(row: JobBoardRow): string {
  const cohort = row.job.cohort?.match(/^20(\d{2})届$/) ? row.job.cohort.slice(2) : row.job.cohort ?? null;
  return [cohort, row.meta?.batch].filter(Boolean).join(' · ');
}

function facetValues(row: JobBoardRow, key: FacetKey): string[] {
  switch (key) {
    case 'batch': return row.meta?.batch ? [row.meta.batch] : [];
    case 'industry': return row.meta?.industry ? [row.meta.industry] : [];
    case 'tag': return typeTagsOf(row);
    case 'city': return citiesOf(row);
    case 'progress': return [progressOf(row)];
  }
}

export interface FacetOption { value: string; label: string; count: number }

/** 每个维度出现过的取值与条数，按条数倒序（进度按固定顺序）。 */
export function facetOptions(rows: readonly JobBoardRow[], key: FacetKey): FacetOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const v of facetValues(row, key)) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (key === 'progress') {
    return (Object.keys(PROGRESS_LABELS) as ProgressKey[]).filter(k => counts.has(k)).map(k => ({ value: k, label: PROGRESS_LABELS[k], count: counts.get(k)! }));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([value, count]) => ({ value, label: value, count }));
}

function matchesFacet(row: JobBoardRow, key: FacetKey, selected: readonly string[]): boolean {
  if (selected.length === 0) return true;
  const values = facetValues(row, key);
  return selected.some(s => values.includes(s));
}

export function filterBoardRows(rows: readonly JobBoardRow[], f: BoardFilterState, today = new Date().toISOString().slice(0, 10)): JobBoardRow[] {
  const q = f.q.trim().toLowerCase();
  const out = rows.filter(row => {
    const { job, match } = row;
    if (q && !`${job.company_name ?? ''} ${job.title}`.toLowerCase().includes(q)) return false;
    if (f.openOnly && ((job.deadline && job.deadline.slice(0, 10) < today) || job.source_status === 'closed')) return false;
    if (f.fitsOnly && match && !match.hard_ok) return false;
    return matchesFacet(row, 'batch', f.batch) && matchesFacet(row, 'industry', f.industry) && matchesFacet(row, 'tag', f.tag)
      && matchesFacet(row, 'city', f.city) && matchesFacet(row, 'progress', f.progress);
  });
  const dl = (r: JobBoardRow) => r.job.deadline ?? '9999';
  return out.sort((a, b) => f.sort === 'deadline' ? dl(a).localeCompare(dl(b))
    : f.sort === 'updated' ? (b.job.updated_at ?? '').localeCompare(a.job.updated_at ?? '')
      : (b.match?.score ?? -1) - (a.match?.score ?? -1) || dl(a).localeCompare(dl(b)));
}

export function activeFilterCount(f: BoardFilterState): number {
  return f.batch.length + f.industry.length + f.tag.length + f.city.length + f.progress.length + (f.q.trim() ? 1 : 0) + (f.fitsOnly ? 1 : 0);
}
