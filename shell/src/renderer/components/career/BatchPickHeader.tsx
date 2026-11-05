/**
 * 「今天这批」表头（plan-r2 §C.2）：一行说清按什么方向、用哪份简历、今天走到哪（点数字看网申进展）；
 * 右侧三枚预设（全部 / 这周截止 / 前 20）只改勾选、不开投；「一家只投一个岗」开关；
 * 下面按需一两句：新网站要登录时攒一起叫、其中几家会直接投出、同一家勾了几个岗、某类网申可以以后直接投。
 */
import { useMemo, useState } from 'react';

import { requestNavigation } from '@/features/career-shell/navModel';

import { careerApi } from './careerApi';
import { delegateDone, delegateQuestion } from './trustText';

/** 「前 20」预设的家数。 */
export const TOP_PRESET = 20;
/** 「这周截止」的天数（和服务端 DEADLINE_WEEK_DAYS 同义）。 */
export const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;

export type Preset = 'all' | 'week' | 'top';
export interface HeaderRow { job_id: string; company: string; known: boolean; delegated: boolean; deadline: string | null; picked: boolean }
export interface HeaderData {
  direction: string[];
  resume: { id: string; name: string } | null;
  today: { sent: number; filling: number; prepared: number };
  propose_delegate: Array<{ key: string; label: string; successes: number }>;
}

const inWeek = (deadline: string | null, now = Date.now()) => {
  if (!deadline) return false;
  const t = Date.parse(deadline);
  return !Number.isNaN(t) && t - now <= WEEK_DAYS * DAY_MS;
};

/** 同一家的判断（和服务端 prePick 一样：去空格，没写公司的算一家）。 */
export const companyKey = (company: string) => company.trim() || '__unknown__';

/** 一家只留第一行（按表里的顺序）。 */
export function onePerCompany<T extends { company: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(r => { const k = companyKey(r.company); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 「全部」那枚的字：家和岗分开说，表里行数比家数多时把岗数也写上。 */
export function allLabel(rows: HeaderRow[], ids: string[]): string {
  const on = new Set(ids);
  const companies = new Set(rows.filter(r => on.has(r.job_id)).map(r => companyKey(r.company))).size;
  const jobs = Math.max(ids.length, rows.length);
  return jobs > companies ? `全部 ${companies} 家（${jobs} 个岗）` : `全部 ${companies} 家`;
}

/** 预设勾哪些：只算出要勾的 id，不开投。 */
export function presetIds(rows: HeaderRow[], preset: Preset, onePer: boolean, now = Date.now()): string[] {
  const base = preset === 'week' ? rows.filter(r => inWeek(r.deadline, now)) : rows;
  const deduped = onePer ? onePerCompany(base) : base;
  return (preset === 'top' ? deduped.slice(0, TOP_PRESET) : deduped).map(r => r.job_id);
}

function TodayNumbers({ today }: { today: HeaderData['today'] }) {
  return (
    <button type="button" onClick={() => requestNavigation({ kind: 'career-live' })} className="tabular-nums text-[var(--muted)] hover:text-[var(--ink)]">
      今天已投出 {today.sent} · 在填 {today.filling} · 备好 {today.prepared}
    </button>
  );
}

function Presets({ rows, onePer, onPreset, onTogglePer }: { rows: HeaderRow[]; onePer: boolean; onPreset: (ids: string[]) => void; onTogglePer: (v: boolean) => void }) {
  // 预设只看哪些行、勾没勾不影响：rows 引用变了（勾选变化）也只重算这三组 id
  const sets = useMemo(() => {
    const all = presetIds(rows, 'all', onePer);
    const week = presetIds(rows, 'week', onePer);
    const shown: Array<[Preset, string, string[]]> = [
      ['all', allLabel(rows, all), all],
      ['week', `这周截止 ${week.length}`, week],
      ['top', `前 ${TOP_PRESET}`, all.slice(0, TOP_PRESET)],
    ];
    return shown.filter(([p, , ids]) => ids.length > 0 && (p !== 'top' || all.length > TOP_PRESET));
  }, [rows, onePer]);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sets.map(([p, label, ids]) => (
        <button key={p} type="button" onClick={() => onPreset(ids)}
          className="h-6 rounded border border-[var(--line)] px-2 text-xs text-[var(--ink-2)] hover:bg-[var(--hover)]">
          {label}
        </button>
      ))}
      <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
        <input type="checkbox" checked={onePer} onChange={e => onTogglePer(e.target.checked)} />一家只投一个岗
      </label>
    </div>
  );
}

/** 表头下按需的几句。 */
function Notes({ rows, onePer, released }: { rows: HeaderRow[]; onePer: boolean; released: boolean }) {
  const picked = rows.filter(r => r.picked);
  const fresh = picked.filter(r => !r.known).length;
  const direct = picked.filter(r => r.delegated).length;
  const dup = new Map<string, number>();
  if (!onePer) for (const r of picked) dup.set(r.company, (dup.get(r.company) ?? 0) + 1);
  const dupLine = [...dup].filter(([, n]) => n > 1).slice(0, 2).map(([c, n]) => `${c}勾了 ${n} 个岗`).join('，');
  const lines = [
    fresh ? `${fresh} 家是新网站，要登录时我攒在一起叫你一次` : null,
    released && direct ? `其中 ${direct} 家会直接投出` : null,
    dupLine || null,
  ].filter((l): l is string => !!l);
  return <>{lines.map(l => <p key={l} className="text-xs text-[var(--muted)]">{l}</p>)}</>;
}

/** 常设授权：某类当面做通够数了，问一次以后直接投。点「好」走信任账本盖章（只由他的动作触发）。 */
function DelegateLine({ entry }: { entry: HeaderData['propose_delegate'][number] }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) return <p className="text-xs text-[var(--muted)]">{delegateDone(entry)}</p>;
  const stamp = () => careerApi.trust(entry.key, 'delegate').then(() => setDone(true)).catch((e: unknown) => {
    console.warn(`[career-card] batch_pick delegate ${entry.key} failed:`, e instanceof Error ? e.message : e);
    setError('没盖上章，再点一次试试');
  });
  return (
    <p className="flex items-center gap-2 text-xs text-[var(--ink-2)]">
      {delegateQuestion(entry)}
      <button type="button" onClick={() => void stamp()} className="rounded border border-[var(--line)] px-1.5 text-xs text-[var(--ink)] hover:bg-[var(--hover)]">好</button>
      {error && <span className="text-[var(--danger)]">{error}</span>}
    </p>
  );
}

export function BatchPickHeader({ data, rows, onePer, released, onPreset, onTogglePer }: {
  data: HeaderData; rows: HeaderRow[]; onePer: boolean; released: boolean;
  onPreset: (ids: string[]) => void; onTogglePer: (v: boolean) => void;
}) {
  const direction = data.direction.length ? `按你的方向：${data.direction.slice(0, 3).join(' · ')}` : '按你的经历挑的';
  return (
    <div className="mb-2 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-[var(--ink-2)]">{direction}</span>
        {data.resume && <span className="text-[var(--muted)]">用「{data.resume.name}」</span>}
        <TodayNumbers today={data.today} />
        <div className="ml-auto"><Presets rows={rows} onePer={onePer} onPreset={onPreset} onTogglePer={onTogglePer} /></div>
      </div>
      <Notes rows={rows} onePer={onePer} released={released} />
      {data.propose_delegate[0] && <DelegateLine entry={data.propose_delegate[0]} />}
    </div>
  );
}
