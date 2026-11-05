/**
 * 下一步条要的状态（plan-r2 §B.2）：主线走到哪、几件等他、底下那张卡、批量在填谁、备好几份、方向内下一批是谁……
 * 全是本地查询，不过模型；等你的事和输入框上沿的等你条同一个来源（asksFor），下一批和勾选表同一个来源（proposeBatch）。
 */
import { INTERVIEW_ROUNDS, INTERVIEW_STATE_KEY, type AskView, type ChatCardRow, type Repos } from '@career/core';
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
import { LOW_POINT_WINDOW_DAYS } from './low-point';
import type { SuggestAsk, SuggestBatch, SuggestCard, SuggestDue, SuggestHeld, SuggestInterview, SuggestJob, SuggestPool, SuggestState, SuggestTailor } from './suggest-types';

export type { SuggestContext, SuggestState } from './suggest-types';

/** 每件事 / 每张卡最多带几家公司名进状态：一句话里只点 2 家，多一家备着去重。 */
const COMPANIES_PER_ITEM = 3;
/** 方向内下一批取前几家：和勾选表默认勾的一小批一样多。 */
const NEXT_JOBS_MAX = 5;
const HOUR_MS = 3_600_000;
/** 从几月（0 起）起校招按明年届算：秋招 7 月前后开始。 */
const AUTUMN_MONTH = 6;
const TAILOR_CARD_KIND = 'tailor_diff';
const PREP_CARD_KIND = 'interview_prep';
const DAY_MS = 86_400_000;
/** 几天内的截止算"快到了"：笔试 / 面试前三天开始准备（plan-r3 §2 S20/S21）。 */
const DUE_SOON_DAYS = 3;
/** 每件事最多带几个选项进建议条（一条只放得下 2 个，多带几个给模型挑）。 */
const ASK_OPTIONS_MAX = 4;
/** 访谈追问最多带几条给模型。 */
const FOLLOW_UPS_MAX = 3;
const OUTSOURCED = /外包|派遣|劳务/;

const PickCardData = z.object({
  rows: z.array(z.object({ job_id: z.string(), company: z.string(), picked: z.boolean() })).default([]),
  more: z.number().default(0),
});
const PrepCardData = z.object({ company: z.string().nullable().optional() });
const InterviewKv = z.object({
  rounds: z.record(z.string(), z.string()).default({}),
  current_round: z.string().nullable().optional(),
  current_experience_id: z.string().nullable().optional(),
  follow_up_questions: z.array(z.string()).default([]),
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
  return {
    id: a.id, kind: a.kind, title: a.title, companies: a.companies.map(c => c.name).slice(0, COMPANIES_PER_ITEM), count: Math.max(1, a.application_ids.length),
    ...(a.mail ? { mail: { purpose: a.mail.purpose, count: a.mail.action_ids.length, bounced: a.mail.bounced === true } } : {}),
    ...(a.mail_failed ? { mail_failed: a.mail_failed } : {}),
  };
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
  const card: SuggestCard = { id: last.id, kind: last.kind, picked: [], pickedIds: [], allIds: [], more: 0, company: null };
  if (last.kind === PREP_CARD_KIND) return { card: { ...card, company: parseCard(PrepCardData, last)?.company ?? null }, tailor: null };
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
  const nextJobs = proposal.rows.filter(r => r.picked).slice(0, NEXT_JOBS_MAX).map(r => ({ job_id: r.job_id, company: r.company, known: r.known, title: r.title }));
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

/** 访谈进度：kv 没有或形状不对返回 null；只有当前轮是 in_progress 才算在访谈里。 */
export function interviewOf(repos: Repos): SuggestInterview | null {
  const raw = repos.kvGet<unknown>(INTERVIEW_STATE_KEY);
  if (raw === undefined || raw === null) return null;
  const parsed = InterviewKv.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[career-suggest] kv ${INTERVIEW_STATE_KEY} shape mismatch: ${parsed.error.issues[0]?.message ?? ''}`);
    return null;
  }
  const kv = parsed.data;
  const round = INTERVIEW_ROUNDS.find(r => r.key === kv.current_round)?.key ?? null;
  const inProgress = !!round && kv.rounds[round] === 'in_progress';
  const expId = kv.current_experience_id ?? null;
  return {
    round,
    inProgress,
    experienceTitle: expId ? repos.getExperience(expId)?.title ?? null : null,
    followUps: inProgress ? kv.follow_up_questions.slice(0, FOLLOW_UPS_MAX) : [],
    roundsTodo: INTERVIEW_ROUNDS.filter(r => (kv.rounds[r.key] ?? 'todo') === 'todo').map(r => r.key),
  };
}

function dueSoonOf(repos: Repos, now: Date): SuggestDue[] {
  const nowIso = now.toISOString();
  const until = new Date(now.getTime() + DUE_SOON_DAYS * DAY_MS).toISOString();
  return repos.listDeadlines({ status: 'open', until })
    .filter(d => d.due_at !== null && d.due_at >= nowIso)
    .map(d => ({
      kind: d.kind,
      company: companyOfApplication(repos, d.application_id) ?? d.title,
      at: d.due_at ?? '',
      daysLeft: Math.max(0, Math.floor((Date.parse(d.due_at ?? nowIso) - Date.parse(startOfDay(now))) / DAY_MS)),
    }));
}

function rejectionsOf(repos: Repos, now: Date): number {
  const since = now.getTime() - LOW_POINT_WINDOW_DAYS * DAY_MS;
  return repos.stageHistory().filter(h => h.to_stage === 'rejected' && Date.parse(h.created_at) >= since).length;
}

/** choice / unsure / confirm 的选项原文：弹窗按钮或缺的那一格的下拉项。 */
function askOptionsOf(asks: readonly AskView[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of asks) {
    const opts = [...(a.choice?.options ?? []), ...(a.fields ?? []).flatMap(f => f.options ?? [])].filter(o => o.trim());
    if (opts.length) out[a.id] = [...new Set(opts)].slice(0, ASK_OPTIONS_MAX);
  }
  return out;
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
    interview: interviewOf(repos),
    dueSoon: dueSoonOf(repos, now),
    rejections7d: rejectionsOf(repos, now),
    askOptions: askOptionsOf(rawAsks),
    cohortGuess: now.getMonth() >= AUTUMN_MONTH ? now.getFullYear() + 1 : now.getFullYear(),
  };
}

/** 旧名（路由按这个名字调）：同 suggestStateOf，会话 id 从 config 读。 */
export function suggestContextOf(repos: Repos, store: CareerStore): SuggestState {
  return suggestStateOf(repos, store);
}
