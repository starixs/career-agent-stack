/**
 * 接管简报（冷启动做法二）：第一次连邮箱、历史邮件收完后，告诉用户替他接管了什么、现在什么在等他、
 * 他大概处在求职的哪个阶段（依据写出来，可以一键改）、哪些邮件没认出来。
 *
 * 报告按邮箱记在 kv 里，历史导入每收完一批累加一次（云端回填会分几次拉下来）；第一次生成时打开简报页。
 */
import type { MailAccount, Repos } from '@career/core';

import { focus, type IntakeDeps } from '../intake';
import type { FetchedMail, MailSyncResult } from './sync';

export interface TakeoverReport {
  account_id: string; address: string;
  started_at: string; updated_at: string; viewed_at: string | null;
  mails: number; by_rules: number; by_model: number; unclassified: number;
  application_ids: string[];
  span: { from: string | null; to: string | null };
}

const reportKey = (accountId: string) => `mail:takeover:${accountId}`;
export const SEASON_KEY = 'career:season';

/** 求职阶段（世界模型第 2 节）：准备期 → 秋招（提前批 → 正式批）→ 春招 → Offer 与三方。 */
export const SEASONS = [
  { id: 'prep', label: '准备期' },
  { id: 'autumn_early', label: '秋招提前批' },
  { id: 'autumn', label: '秋招正式批' },
  { id: 'spring', label: '春招' },
  { id: 'offer', label: 'Offer 与三方' },
] as const;
export type SeasonId = typeof SEASONS[number]['id'];
export function isSeasonId(v: unknown): v is SeasonId { return SEASONS.some(s => s.id === v); }

/** 「最近」算多久：这段时间里有求职邮件，就说明他正在投。 */
const RECENT_DAYS = 30;

function spanOf(mails: FetchedMail[], prev: TakeoverReport['span']): TakeoverReport['span'] {
  const dates = mails.map(m => m.received_at).filter((d): d is string => !!d).concat([prev.from, prev.to].filter((d): d is string => !!d)).sort();
  return { from: dates[0] ?? null, to: dates.at(-1) ?? null };
}

/** 历史导入收完一批后调用；第一次生成报告时把简报页推到前面。 */
export function recordTakeover(deps: IntakeDeps, account: MailAccount, result: MailSyncResult, mails: FetchedMail[]): TakeoverReport | null {
  const h = result.history;
  if (!h) return null;
  const now = new Date().toISOString();
  const prev = deps.repos.kvGet<TakeoverReport>(reportKey(account.id));
  const next: TakeoverReport = {
    account_id: account.id, address: account.address,
    started_at: prev?.started_at ?? now, updated_at: now, viewed_at: prev?.viewed_at ?? null,
    mails: (prev?.mails ?? 0) + result.job_related, by_rules: (prev?.by_rules ?? 0) + h.by_rules, by_model: (prev?.by_model ?? 0) + h.by_model,
    unclassified: (prev?.unclassified ?? 0) + h.unclassified,
    application_ids: [...new Set([...(prev?.application_ids ?? []), ...h.application_ids])],
    span: spanOf(mails, prev?.span ?? { from: null, to: null }),
  };
  deps.repos.kvSet(reportKey(account.id), next);
  if (!prev) focus(deps, { surface: 'takeover', id: account.id, note: '历史邮件收好了，看看替你接管了什么' });
  return next;
}

export function markTakeoverViewed(repos: Repos, accountId: string): void {
  const r = repos.kvGet<TakeoverReport>(reportKey(accountId));
  if (r && !r.viewed_at) repos.kvSet(reportKey(accountId), { ...r, viewed_at: new Date().toISOString() });
}

export function latestTakeover(repos: Repos, accountId?: string | null): TakeoverReport | null {
  const ids = accountId ? [accountId] : repos.listMailAccounts().map(a => a.id);
  const reports = ids.map(id => repos.kvGet<TakeoverReport>(reportKey(id))).filter((r): r is TakeoverReport => !!r);
  return reports.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
}

/** 阶段判断：用户改过就听用户的；否则按有没有 Offer、最近有没有求职邮件、现在几月推。 */
export function guessSeason(repos: Repos, nowIso: string): { id: SeasonId; label: string; basis: string; source: 'user' | 'guess' } {
  const label = (id: SeasonId) => SEASONS.find(s => s.id === id)?.label ?? id;
  const saved = repos.kvGet<{ id: SeasonId; at: string }>(SEASON_KEY);
  if (saved && isSeasonId(saved.id)) return { id: saved.id, label: label(saved.id), basis: '你自己选的', source: 'user' };
  const apps = repos.applicationsWithJob();
  const offers = apps.filter(a => a.stage === 'offer' || a.stage === 'hired').length;
  if (offers) return { id: 'offer', label: label('offer'), basis: `手里有 ${offers} 个 Offer`, source: 'guess' };
  const since = new Date(Date.parse(nowIso) - RECENT_DAYS * 86_400_000).toISOString();
  const recent = repos.listMailMessages({ relevance: 'job', limit: 1000 }).filter(m => (m.received_at ?? '') >= since).length;
  const month = new Date(nowIso).getMonth() + 1;
  if (!apps.length && !recent) return { id: 'prep', label: label('prep'), basis: '邮箱里还没有求职邮件，也没有投递记录', source: 'guess' };
  const id: SeasonId = month >= 7 && month <= 8 ? 'autumn_early' : month >= 9 ? 'autumn' : 'spring';
  const basis = recent ? `近 ${RECENT_DAYS} 天收到 ${recent} 封求职邮件，现在是 ${month} 月` : `有 ${apps.length} 份投递，但近 ${RECENT_DAYS} 天没有新邮件，现在是 ${month} 月`;
  return { id, label: label(id), basis, source: 'guess' };
}

const BUCKETS = [
  { id: 'applied', label: '已投递', stages: ['applied', 'responded', 'pending', 'approved', 'evaluated', 'ready'] },
  { id: 'interview', label: '面试中', stages: ['interview'] },
  { id: 'offer', label: 'Offer', stages: ['offer', 'hired'] },
  { id: 'closed', label: '已结束', stages: ['rejected', 'discarded', 'skip'] },
] as const;

/** 拼简报：报告 + 这些申请现在的样子 + 还没发生的事 + 阶段 + 没认出的邮件。 */
export function takeoverBriefing(repos: Repos, accountId: string | null | undefined, nowIso: string) {
  const report = latestTakeover(repos, accountId);
  if (!report) return null;
  const ids = new Set(report.application_ids);
  const apps = repos.applicationsWithJob().filter(a => ids.has(a.id));
  const buckets = BUCKETS.map(b => ({
    id: b.id, label: b.label,
    items: apps.filter(a => (b.stages as readonly string[]).includes(a.stage)).map(a => ({ application_id: a.id, company: a.job.company_name, title: a.job.title, stage: a.stage })),
  }));
  const needs = repos.listDeadlines({ status: 'open' })
    .filter(d => d.application_id && ids.has(d.application_id) && (!d.due_at || d.due_at >= nowIso))
    .map(d => ({ deadline_id: d.id, application_id: d.application_id, kind: d.kind, title: d.title, due_at: d.due_at, url: d.url }));
  const unclassified = repos.listMailMessages({ account_id: report.account_id, relevance: 'unknown', limit: 50 })
    .map(m => ({ mail_id: m.id, subject: m.subject, from: m.from_addr, received_at: m.received_at }));
  return { report, applications: apps.length, buckets, needs, season: guessSeason(repos, nowIso), seasons: SEASONS, unclassified };
}
