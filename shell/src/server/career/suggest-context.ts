/**
 * 下一步条要的状态（plan-r2 §B.2）：主线走到哪、几件等他、底下那张卡、批量在填谁、备好几份、方向内下一批是谁……
 * 全是本地查询，不过模型；等你的事和输入框上沿的等你条同一个来源（asksFor），下一批和勾选表同一个来源（proposeBatch）。
 */
import type { AskView, ChatCardRow, Repos } from '@career/core';
import { z } from 'zod';

import { PHONE_KV_KEY, parseBinding } from '../../shared/careerPhone';
import { BATCH_STATE_KEY, type BatchState } from './batch-runner';
import { BATCH_PICK_CARD_KIND, proposeBatch } from './batch-propose';
import { asksFor } from './delivery';
import { getJobPrefs, jobBoard } from './job-board';
import { careerProductSessionId } from './product-session';
import { mainlineStage, receipts } from './rail';
import type { CareerStore } from './store';
import { readLedger } from './trust-ledger';
import type { SuggestAsk, SuggestBatch, SuggestCard, SuggestHeld, SuggestJob, SuggestPool, SuggestState, SuggestTailor } from './suggest-types';

export type { SuggestContext, SuggestState } from './suggest-types';

/** 每件事 / 每张卡最多带几家公司名进状态：一句话里只点 2 家，多一家备着去重。 */
const COMPANIES_PER_ITEM = 3;
/** 方向内下一批取前几家：和勾选表默认勾的一小批一样多。 */
const NEXT_JOBS_MAX = 5;
const HOUR_MS = 3_600_000;
/** 从几月（0 起）起校招按明年届算：秋招 7 月前后开始。 */
const AUTUMN_MONTH = 6;
const TAILOR_CARD_KIND = 'tailor_diff';
const OUTSOURCED = /外包|派遣|劳务/;

const PickCardData = z.object({
  rows: z.array(z.object({ job_id: z.string(), company: z.string(), picked: z.boolean() })).default([]),
  more: z.number().default(0),
});
const TailorCardData = z.object({
  tailored_id: z.string(), job_id: z.string(), company: z.string().nullable().optional(), total: z.number().default(0),
});

function parseCard<T>(schema: z.ZodType<T>, card: ChatCardRow): T | null {
  try {
    const out = schema.safeParse(JSON.parse(card.data_json));
    if (out.success) return out.data;
    console.warn(`[career-suggest] card ${card.id} kind=${card.kind} data shape mismatch`);
  } catch (error) {
    console.warn(`[career-suggest] card ${card.id} data not JSON:`, error instanceof Error ? error.message : error);
  }
  return null;
}

function askOf(a: AskView): SuggestAsk {
  return { id: a.id, kind: a.kind, title: a.title, companies: a.companies.map(c => c.name).slice(0, COMPANIES_PER_ITEM), count: Math.max(1, a.application_ids.length) };
}

function companyOfApplication(repos: Repos, appId: string | null): string | null {
  const app = appId ? repos.getApplication(appId) : undefined;
  return app ? repos.getJob(app.job_id)?.company_name ?? null : null;
}

function batchOf(repos: Repos): SuggestBatch | null {
  const s = repos.kvGet<BatchState>(BATCH_STATE_KEY);
  if (!s) return null;
  const running = s.status === 'running' ? (s.running ?? []) : [];
  const appIds = running.map(r => repos.getAction(r.actionId)?.application_id ?? null);
  const companies = appIds.map(id => companyOfApplication(repos, id)).filter((c): c is string => !!c);
  return { status: s.status, running: companies, runningAppId: appIds.find((x): x is string => !!x) ?? null, done: s.done, queued: s.queued };
}

function heldOf(repos: Repos, asks: readonly AskView[]): SuggestHeld {
  const submits = repos.listActions('pending_review').filter(a => a.kind === 'submit');
  const ids = new Set(submits.map(a => a.id));
  const ask = asks.filter(a => a.kind === 'review' && a.sources.some(s => ids.has(s.id)))
    .sort((a, b) => b.application_ids.length - a.application_ids.length)[0];
  const companies = submits.map(a => companyOfApplication(repos, a.application_id)).filter((c): c is string => !!c);
  return { count: submits.length, companies: [...new Set(companies)].slice(0, COMPANIES_PER_ITEM), askId: ask?.id ?? null };
}

/** 最近一张还在等他的卡（勾选表 / 定制卡 / 其他）。 */
function openCardOf(repos: Repos, sessionId: string | null): { card: SuggestCard | null; tailor: SuggestTailor | null } {
  const pending = sessionId ? repos.listChatCards(sessionId).filter(c => c.state === 'pending') : [];
  const last = pending.at(-1);
  if (!last) return { card: null, tailor: null };
  const card: SuggestCard = { id: last.id, kind: last.kind, picked: [], pickedIds: [], allIds: [], more: 0 };
  if (last.kind === BATCH_PICK_CARD_KIND) {
    const data = parseCard(PickCardData, last);
    const picked = (data?.rows ?? []).filter(r => r.picked);
    return { card: { ...card, picked: picked.map(r => r.company).slice(0, COMPANIES_PER_ITEM), pickedIds: picked.map(r => r.job_id), allIds: (data?.rows ?? []).map(r => r.job_id), more: data?.more ?? 0 }, tailor: null };
  }
  if (last.kind === TAILOR_CARD_KIND) {
    const data = parseCard(TailorCardData, last);
    const tailor = data ? { card_id: last.id, company: data.company ?? '', job_id: data.job_id, tailored_id: data.tailored_id, changes: data.total } : null;
    return { card, tailor };
  }
  return { card, tailor: null };
}

function jobsAndPool(repos: Repos, store: CareerStore): { nextJobs: SuggestJob[]; pool: SuggestPool } {
  const proposal = proposeBatch(repos, store);
  const nextJobs = proposal.rows.filter(r => r.picked).slice(0, NEXT_JOBS_MAX).map(r => ({ job_id: r.job_id, company: r.company, known: r.known }));
  const open = jobBoard(repos, { open_only: true });
  const ready = new Set(proposal.rows.map(r => r.job_id));
  const outsourced = open.filter(r => ready.has(r.job.id) && OUTSOURCED.test(`${r.job.title} ${r.job.company_name ?? ''} ${(r.meta.type_tags ?? []).join(' ')}`)).length;
  return { nextJobs, pool: { fits: proposal.rows.length + proposal.more, total: open.length, outsourced } };
}

function awayHoursOf(repos: Repos, sessionId: string | null, now: Date): number | null {
  if (!sessionId) return null;
  const row = repos.db.get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM message WHERE session_id=? AND role='user'`, [sessionId]);
  const at = row?.at ? Date.parse(row.at) : NaN;
  return Number.isFinite(at) ? Math.max(0, (now.getTime() - at) / HOUR_MS) : null;
}

function startOfDay(now: Date): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface SuggestStateOptions {
  /** 个人助理会话 id；缺省从 config 读（careerProductSessionId）。 */
  sessionId?: string | null;
  now?: Date;
}

export function suggestStateOf(repos: Repos, store: CareerStore, opts: SuggestStateOptions = {}): SuggestState {
  const now = opts.now ?? new Date();
  const sessionId = opts.sessionId === undefined ? careerProductSessionId() ?? null : opts.sessionId;
  const prefs = getJobPrefs(repos);
  const sent = receipts(repos);
  const rawAsks = asksFor(repos, now.toISOString());
  const { card, tailor } = openCardOf(repos, sessionId);
  const masters = store.listResumeMasters();
  const today = startOfDay(now);
  return {
    stage: mainlineStage(repos, store, sent.length, Object.values(readLedger(repos))),
    asks: rawAsks.map(askOf),
    openCard: card,
    batch: batchOf(repos),
    held: heldOf(repos, rawAsks),
    ...jobsAndPool(repos, store),
    prefs: { keywords: prefs.keywords ?? [], cities: prefs.cities ?? [], cohort: prefs.cohort ?? null },
    resume: { has: masters.length > 0, name: masters[0]?.name ?? null, tailored: store.listResumeTailored().length, experiences: repos.listExperiences().length },
    mailConnected: repos.listMailAccounts().length > 0,
    phoneLinked: parseBinding(repos.kvGet(PHONE_KV_KEY)) !== null,
    lastTailor: tailor,
    todaySent: sent.filter(r => r.at >= today).length,
    awayHours: awayHoursOf(repos, sessionId, now),
    hour: now.getHours(),
    cohortGuess: now.getMonth() >= AUTUMN_MONTH ? now.getFullYear() + 1 : now.getFullYear(),
  };
}

/** 旧名（路由按这个名字调）：同 suggestStateOf，会话 id 从 config 读。 */
export function suggestContextOf(repos: Repos, store: CareerStore): SuggestState {
  return suggestStateOf(repos, store);
}
