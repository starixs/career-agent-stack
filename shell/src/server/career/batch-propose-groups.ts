/**
 * 「今天这批」勾选表的分组、默认勾选和记忆（plan-r2 §C.2）。
 *
 * - 默认勾几家：投出不到 5 份时只勾一小批（首批看得过来），之后勾满方向内全部，一家公司只勾一个岗；
 * - 分组：有截止的够多就按截止分（3 天内 / 这周 / 之后 / 截止没写），否则方向词有两个以上按方向词，否则一组；
 * - 上次没投的：默认勾了、他确认时取消掉的记进 kv `batch:unpicked`，下次放在最后一组、默认收起不勾；勾上投出后移除。
 */
import type { Repos } from '@career/core';

/** 首批一小批：投出不到这么多份时，默认只勾这么多家（face-mainline「再投一小批」，plan-r2 §A.2 只管第一批）。 */
export const FIRST_BATCH_SIZE = 5;
/** 截止分组的阈值：至少这么大比例的行写了截止，按截止分组才有意义（plan-r2 §C.2）。 */
export const DEADLINE_GROUP_MIN_SHARE = 0.3;
/** 「3 天内截止」组的天数。 */
export const DEADLINE_SOON_DAYS = 3;
/** 「这周截止」组（以及表头预设「这周截止」）的天数。 */
export const DEADLINE_WEEK_DAYS = 7;
export const UNPICKED_KEY = 'batch:unpicked';
export const UNPICKED_GROUP_ID = 'unpicked';
const DAY_MS = 86_400_000;

export type GroupBy = 'deadline' | 'direction' | 'single';
export interface BatchPickGroup { id: string; title: string; collapsed: boolean }

/** 默认勾几家：没投出过几份 → 一小批；之后 → 方向内全部（不设上限）。 */
export function defaultPickCount(sentCount: number): number {
  return sentCount < FIRST_BATCH_SIZE ? FIRST_BATCH_SIZE : Number.POSITIVE_INFINITY;
}

/** 一家公司只预勾一个岗，按顺序勾满 limit 家；skip 里的行（上次没投的）不勾。 */
export function prePick<T extends { company: string; job_id?: string }>(rows: T[], limit: number, skip: Set<string> = new Set()): Array<T & { picked: boolean }> {
  const seen = new Set<string>();
  let count = 0;
  return rows.map(row => {
    const key = row.company.trim() || '__unknown__';
    const picked = count < limit && !seen.has(key) && !(row.job_id && skip.has(row.job_id));
    if (picked) { seen.add(key); count += 1; }
    return { ...row, picked };
  });
}

/** 截止离今天还有几天（没写截止 → null）。 */
export function daysLeft(deadline: string | null, today: string): number | null {
  if (!deadline) return null;
  const d = Date.parse(deadline.slice(0, 10));
  const t = Date.parse(today);
  return Number.isNaN(d) || Number.isNaN(t) ? null : Math.round((d - t) / DAY_MS);
}

function deadlineBucket(deadline: string | null, today: string): string {
  const left = daysLeft(deadline, today);
  if (left === null) return 'deadline:unknown';
  if (left <= DEADLINE_SOON_DAYS) return 'deadline:soon';
  return left <= DEADLINE_WEEK_DAYS ? 'deadline:week' : 'deadline:later';
}

const DEADLINE_GROUPS: BatchPickGroup[] = [
  { id: 'deadline:soon', title: `${DEADLINE_SOON_DAYS} 天内截止`, collapsed: false },
  { id: 'deadline:week', title: '这周截止', collapsed: false },
  { id: 'deadline:later', title: '之后截止', collapsed: false },
  { id: 'deadline:unknown', title: '截止没写', collapsed: false },
];

interface Groupable { job_id: string; title: string; deadline: string | null; text: string }

/** 服务端定怎么分：截止够多 → 按截止；方向词 ≥2 → 按方向词；否则一组。 */
export function chooseGroupBy(rows: Array<{ deadline: string | null }>, keywords: string[]): GroupBy {
  const withDeadline = rows.filter(r => r.deadline).length;
  if (rows.length && withDeadline / rows.length >= DEADLINE_GROUP_MIN_SHARE) return 'deadline';
  return keywords.length >= 2 ? 'direction' : 'single';
}

/** 给每行定组，返回有行的组（按固定顺序），上次没投的永远最后一组、默认收起。 */
export function assignGroups<T extends Groupable>(rows: T[], by: GroupBy, keywords: string[], unpicked: Set<string>, today: string): { rows: Array<T & { group: string }>; groups: BatchPickGroup[] } {
  const kw = keywords.map(k => ({ k, low: k.toLowerCase() }));
  const groupOf = (r: T): string => {
    if (unpicked.has(r.job_id)) return UNPICKED_GROUP_ID;
    if (by === 'deadline') return deadlineBucket(r.deadline, today);
    if (by === 'direction') return `kw:${kw.find(x => r.text.toLowerCase().includes(x.low))?.k ?? ''}`;
    return 'all';
  };
  const tagged = rows.map(r => ({ ...r, group: groupOf(r) }));
  const used = new Set(tagged.map(r => r.group));
  const base: BatchPickGroup[] = by === 'deadline' ? DEADLINE_GROUPS
    : by === 'direction' ? [...keywords.map(k => ({ id: `kw:${k}`, title: k, collapsed: false })), { id: 'kw:', title: '其他', collapsed: false }]
      : [{ id: 'all', title: '能投的', collapsed: false }];
  const left = tagged.filter(r => r.group === UNPICKED_GROUP_ID).length;
  const groups = [...base, { id: UNPICKED_GROUP_ID, title: `上次没投的 ${left} 家`, collapsed: true }].filter(g => used.has(g.id));
  const order = new Map(groups.map((g, i) => [g.id, i]));
  return { rows: [...tagged].sort((a, b) => (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0)), groups };
}

// ----- 上次没投的（记忆） -----

type UnpickedMap = Record<string, string>;

export function readUnpicked(repos: Repos): UnpickedMap {
  return repos.kvGet<UnpickedMap>(UNPICKED_KEY) ?? {};
}

/**
 * 确认时：出表时默认勾了、他取消掉的记下（带时间），勾上开始投的移除。
 * 本来就没默认勾的行不记——那不是他说的"这次不投"（verify-r2 #1：首批只勾 5，其余不该全进"上次没投的"）。
 */
export function rememberUnpicked(repos: Repos, defaultPickedIds: string[], startedIds: string[], at = new Date().toISOString()): number {
  const started = new Set(startedIds);
  const next: UnpickedMap = { ...readUnpicked(repos) };
  for (const id of started) delete next[id];
  for (const id of defaultPickedIds) if (!started.has(id) && !next[id]) next[id] = at;
  repos.kvSet(UNPICKED_KEY, next);
  return Object.keys(next).length;
}
