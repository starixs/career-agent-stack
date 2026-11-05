/**
 * 「今天这批」勾选表的候选（face-beta-polish 2026-11-05；plan-r2 §C 改为撑得住一天几十份）。
 *
 * 所有入口（第一份投出之后、建议条、右栏「再投一批」、功能市场、网申进展空状态）都汇到这里，
 * 出的是同一张 `batch_pick` 卡。只挑「现在就能开始」的岗位（planJobs 过一遍：没写怎么投、已在投、已投过的不进表；只收邮件的岗位照样进表），
 * 届别和他不符的不进表；方向内能投的全部列出（不设上限），分组可折叠；
 * 默认勾选：投出不到 5 份时只勾一小批，之后勾满方向内全部，一家公司只勾一个岗（怕同一家投多个岗被锁）；
 * 上次没勾的收在最后一组、不勾。每行带网申系统在信任账本里的状态、截止、这家会用哪份简历。
 */
import { applyChannelOf, normalizeCohort, type Repos } from '@career/core';
import { z } from 'zod';

import { isDraftingMail, isHeldAction } from './apply-actions';
import { applyJobs, planJobs } from './batch-apply';
import {
  assignGroups, chooseGroupBy, defaultPickCount, prePick, readUnpicked, rememberUnpicked,
  type BatchPickGroup, type GroupBy,
} from './batch-propose-groups';
import { BATCH_STATE_KEY, type BatchState } from './batch-runner';
import { settleChatCard, type PostChatCard } from './chat-card-push';
import { getJobPrefs, jobBoard, type BoardRow } from './job-board';
import { resumePlanForJob, type PacketDeps, type ResumePlan } from './packets';
import { mainlineStage, receipts } from './rail';
import type { CareerStore } from './store';
import { careerProductSessionId } from './product-session';
import { markedTargetJobs } from './targets';
import { readLedger, shouldProposeDelegate, systemOfSync, type TrustLedger } from './trust-ledger';

import type { MainlineStage } from '../../shared/careerRail';

export { defaultPickCount, prePick } from './batch-propose-groups';
export type { ResumePlan, ResumePlanKind } from './packets';
export const BATCH_PICK_CARD_KIND = 'batch_pick';
export interface BatchPickRow {
  job_id: string;
  company: string;
  title: string;
  city: string | null;
  /** 网申系统的名字（北森、Moka…；认不出时按网站）；邮件投递的写「邮件」。 */
  system: string | null;
  /** 投递通道：网申填表 / 发邮件（JD 写明发邮箱的）。 */
  channel: 'web' | 'mail';
  /** 这一类在他这儿投通过（shown / delegated）= true；没投过 = false，会先停给他看。 */
  known: boolean;
  /** 这一类他盖过章：填好直接投出，不停。 */
  delegated: boolean;
  /** 标了星：填好先给他看，不进一键投出。 */
  target: boolean;
  deadline: string | null;
  /** 所在组（groups 里的 id）。 */
  group: string;
  /** 这家投时用哪份简历（packets.resumePlanForJob）。 */
  resume_plan: ResumePlan;
  picked: boolean;
}

export interface BatchProposal {
  rows: BatchPickRow[];
  groups: BatchPickGroup[];
  group_by: GroupBy;
  /** 能投但没列进表的家数（不设上限后恒为 0，留给旧卡）。 */
  more: number;
  /** 方向（他说过的关键词），用于表头"按你的方向：…"。 */
  direction: string[];
  /** 统一用哪份主简历（没有定制版时）。 */
  resume: { id: string; name: string } | null;
  /** 挡住整批的原因：还没有简历时一家都开始不了，要如实说，不说成"没有能投的岗位"。 */
  blocked: 'no_resume' | null;
  /** 主线走到哪：first / batch 时表下说一句"填到提交前停下"，released 后不说。 */
  stage: MainlineStage;
  /** 表头的今天三个数（出表那一刻，和右栏同一来源）。 */
  today: { sent: number; filling: number; prepared: number };
  /** 当面做通够数、可以问"以后直接投？"的几类（trust-ledger.shouldProposeDelegate）。 */
  propose_delegate: Array<{ key: string; label: string; successes: number }>;
  /** 「换一批」时排除了刚才那张表上默认勾的几家；排完一家不剩时前端说"刚才那张还在上面"。 */
  excluded: number;
}

export interface ProposeOptions {
  /** 只列这几家（建议条点名的），默认全勾。 */
  job_ids?: string[];
  /** all = 不管投出过几份，默认勾满（一家一个岗）。 */
  pick?: 'default' | 'all';
  /** 默认勾几家；不传按 defaultPickCount。 */
  limit?: number;
  /** 不列这几家（「换一批」：刚才那张表上默认勾的）。 */
  exclude?: string[];
}

/** 邮件投递的行：系统一栏写「邮件」；写好了一律先给他过目（发送永远过人），不是「新系统 · 先停给你看」。 */
const MAIL_SYSTEM_LABEL = '邮件';

function toRow(r: BoardRow, marked: Set<string>, ledger: TrustLedger, plan: (id: string) => ResumePlan): Omit<BatchPickRow, 'picked' | 'group'> {
  const mail = applyChannelOf(r.job) === 'mail';
  const sys = !mail && r.job.url ? systemOfSync(r.job.url) : null;
  const trust = sys ? ledger[sys.key]?.state ?? 'new' : 'new';
  return {
    job_id: r.job.id,
    company: r.job.company_name ?? '',
    title: r.job.title,
    city: r.job.location,
    system: mail ? MAIL_SYSTEM_LABEL : sys?.label ?? null,
    channel: mail ? 'mail' : 'web',
    known: mail || trust !== 'new',
    delegated: !mail && trust === 'delegated',
    target: marked.has(r.job.id) || r.target !== null,
    deadline: r.job.deadline ? r.job.deadline.slice(0, 10) : null,
    resume_plan: plan(r.job.id),
  };
}

const mentions = (r: BoardRow, keywords: string[]) =>
  !keywords.length || keywords.some(k => `${r.job.title} ${r.job.jd_raw ?? ''}`.toLowerCase().includes(k.toLowerCase()));

/** 按他的方向挑出现在就能投的岗位；届别写明且和他不符的不要（E#5）。点名了几家就只看这几家。 */
function candidates(repos: Repos, jobIds?: string[], exclude: readonly string[] = []): BoardRow[] {
  const prefs = getJobPrefs(repos);
  const skip = new Set(exclude);
  const keywords = prefs.keywords ?? [];
  const mine = normalizeCohort(prefs.cohort ?? '');
  const named = jobIds?.length ? new Set(jobIds) : null;
  return jobBoard(repos, { open_only: true, fits_only: true, sort: 'match' })
    .filter(r => !r.application && !skip.has(r.job.id))
    .filter(r => { const theirs = normalizeCohort(r.job.cohort ?? ''); return !mine || !theirs || theirs === mine; })
    .filter(r => named ? named.has(r.job.id) : mentions(r, keywords));
}

/** 表头的今天三个数：今天投出、在填（已批准还没填完的网申 + 在写的邮件）、备好（停在提交前的网申 + 写好待发的邮件）。 */
function todayNumbers(repos: Repos, sentList: Array<{ at: string }>): BatchProposal['today'] {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const iso = since.toISOString();
  const running = repos.kvGet<BatchState>(BATCH_STATE_KEY)?.running?.length ?? 0;
  const queued = repos.listActions('approved').filter(a => a.kind === 'fill_form').length;
  const drafting = repos.listActions().filter(isDraftingMail).length;
  const prepared = repos.listActions('pending_review').filter(isHeldAction).length;
  return { sent: sentList.filter(r => r.at >= iso).length, filling: running + queued + drafting, prepared };
}

/** 排序：会了的系统先跑、新网站后跑（E#7，新网站要登录的攒在后面一起叫他）。 */
const knownFirst = <T extends { known: boolean }>(rows: T[]): T[] => [...rows].sort((a, b) => Number(b.known) - Number(a.known));

export function proposeBatch(repos: Repos, store: CareerStore, opts: ProposeOptions = {}): BatchProposal {
  const pool = candidates(repos, opts.job_ids, opts.exclude);
  const ready = new Set(planJobs(repos, store, pool.map(r => r.job.id)).ready);
  const marked = markedTargetJobs(repos);
  const ledger = readLedger(repos);
  const sentList = receipts(repos);
  const direction = getJobPrefs(repos).keywords ?? [];
  const unpicked = opts.job_ids?.length ? new Set<string>() : new Set(Object.keys(readUnpicked(repos)));
  const master = store.listResumeMasters()[0];
  const base = knownFirst(pool.filter(r => ready.has(r.job.id)).map(r => toRow(r, marked, ledger, id => resumePlanForJob(store, repos, id, master?.id))));
  const by = chooseGroupBy(base, direction);
  const today = new Date().toISOString().slice(0, 10);
  const jd = new Map(pool.map(r => [r.job.id, `${r.job.title} ${r.job.jd_raw ?? ''}`]));
  const grouped = assignGroups(base.map(r => ({ ...r, text: jd.get(r.job_id) ?? r.title })), by, direction, unpicked, today);
  const limit = opts.limit ?? (opts.pick === 'all' || opts.job_ids?.length ? Number.POSITIVE_INFINITY : defaultPickCount(sentList.length));
  const rows = prePick(grouped.rows.map(({ text: _text, ...r }) => r), limit, unpicked);
  return {
    rows, groups: grouped.groups, group_by: by, more: 0, direction,
    resume: master ? { id: master.id, name: master.name } : null,
    blocked: master ? null : 'no_resume',
    stage: mainlineStage(repos, store, sentList.length, Object.values(ledger)),
    today: todayNumbers(repos, sentList),
    propose_delegate: Object.values(ledger).filter(e => e.kind === 'system' && shouldProposeDelegate(e)).map(e => ({ key: e.key, label: e.label, successes: e.successes })),
    excluded: opts.exclude?.length ?? 0,
  };
}

/** 卡片标题：一句问话，数字是默认勾的家数。 */
export function proposalTitle(p: BatchProposal): string {
  if (p.blocked === 'no_resume') return '投之前先要一份简历';
  const n = p.rows.filter(r => r.picked).length;
  if (n) return `先投这 ${n} 家？`;
  if (!p.rows.length && p.excluded) return '这个方向能投的都在刚才那批里了';
  return p.rows.length ? `上次没投的 ${p.rows.length} 家，这次投吗？` : '现在没有能直接投的岗位';
}

function postCard(post: PostChatCard, p: BatchProposal, now: number, why: 'asked' | 'after-submit'): string {
  const id = `batch-pick:${now}`;
  post({ id, kind: BATCH_PICK_CARD_KIND, title: proposalTitle(p), data: { ...p } });
  console.log(`[career] batch-pick posted why=${why} rows=${p.rows.length} picked=${p.rows.filter(r => r.picked).length} groups=${p.group_by}:${p.groups.length}`);
  return id;
}

/**
 * 在对话里放一张勾选表。每次是新的一张（id 带时间）。
 * 对话里已有一张没处理的（「换一批」）：新表不列它默认勾的那几家，旧的那张收起；
 * 排完一家不剩就不收旧表，新卡如实说"能投的都在刚才那批里了"。
 */
export function postProposal(
  repos: Repos, store: CareerStore, post: PostChatCard, opts: ProposeOptions = {},
  sessionId: string | null = careerProductSessionId() ?? null, now = Date.now(),
): { posted: boolean; picked: number; card_id: string } {
  const open = opts.job_ids?.length ? [] : openProposals(repos, sessionId);
  const exclude = [...new Set(open.flatMap(c => cardRows(repos, c.id).filter(r => r.picked).map(r => r.job_id)))];
  const p = proposeBatch(repos, store, exclude.length ? { ...opts, exclude } : opts);
  if (p.rows.length) for (const c of open) settleChatCard(repos, c.id, { done_line: '换了一批' }, 'dismissed');
  const cardId = postCard(post, p, now, 'asked');
  if (open.length) console.log(`[career] batch-pick reshuffle open=${open.length} excluded=${exclude.length} rows=${p.rows.length}`);
  return { posted: true, picked: p.rows.filter(r => r.picked).length, card_id: cardId };
}

const CardRows = z.object({ rows: z.array(z.object({ job_id: z.string(), picked: z.boolean().default(false) }).passthrough()).default([]) }).passthrough();

/** 这张卡上列过的岗位，带出表时默认勾没勾（用来记"上次没投的"、「换一批」排除）。 */
function cardRows(repos: Repos, cardId: string): Array<{ job_id: string; picked: boolean }> {
  const raw = repos.getChatCard(cardId)?.data_json;
  if (!raw) return [];
  try {
    const parsed = CardRows.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.rows.map(r => ({ job_id: r.job_id, picked: r.picked }));
    console.warn(`[career] batch-pick card=${cardId} rows 不合格式，这次不记没勾的: ${parsed.error.message}`);
  } catch (error) {
    console.warn(`[career] batch-pick card=${cardId} data 解析失败，这次不记没勾的:`, error instanceof Error ? error.message : error);
  }
  return [];
}

/** done_line 里每条原因最多这么多字（收起那一行要一眼看完）。 */
const REASON_MAX = 14;
/** done_line 里最多列几条不同的原因，再多说"另有 n 家"。 */
const REASONS_SHOWN = 2;

/** 收起那一行：开始了几家（其中几封邮件在写），没开始的说前两条原因（如"简历里缺手机号"），他知道去补什么。 */
export function startDoneLine(started: number, skipped: Array<{ reason: string }>, mails = 0): string {
  const head = started ? `已开始投 ${started} 家${mails ? ` · 其中 ${mails} 封邮件在写` : ''}` : '这批一家都没能开始';
  if (!skipped.length) return head;
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const top = [...counts].slice(0, REASONS_SHOWN);
  const rest = skipped.length - top.reduce((n, [, c]) => n + c, 0);
  const why = top.map(([r]) => (r.length > REASON_MAX ? `${r.slice(0, REASON_MAX)}…` : r)).join('；');
  return `${head} · ${skipped.length} 家没开始：${why}${rest ? `，另有 ${rest} 家` : ''}`;
}

/**
 * 勾选表点了「投这 N 家」：开始投，并把卡收成"已开始投 N 家"。
 * "上次没投的"只记出表时默认勾了、他取消掉的那几家；本来就没勾的不算他说过"不投"（verify-r2 #1）。
 */
export async function startFromCard(deps: PacketDeps & { store: CareerStore }, cardId: string, jobIds: string[], resumeId: string | null) {
  const defaultPicked = cardRows(deps.repos, cardId).filter(r => r.picked).map(r => r.job_id);
  const res = await applyJobs(deps, jobIds, resumeId);
  const left = rememberUnpicked(deps.repos, defaultPicked, jobIds);
  console.log(`[career] batch-pick start card=${cardId} picked=${jobIds.length} started=${res.started.length} skipped=${res.skipped.length} unpicked_kept=${left}`);
  settleChatCard(deps.repos, cardId, { done_line: startDoneLine(res.started.length, res.skipped, res.mails), started: res.started.length }, 'completed');
  return res;
}

function openProposals(repos: Repos, sessionId: string | null) {
  if (!sessionId) return [];
  return repos.listChatCards(sessionId).filter(c => c.kind === BATCH_PICK_CARD_KIND && c.state === 'pending');
}

/** 对话里已经有一张没处理的勾选表：不再自动出第二张。 */
export function hasOpenProposal(repos: Repos, sessionId: string | null): boolean {
  return openProposals(repos, sessionId).length > 0;
}

/**
 * 他在提交卡上点了头（第一份当面投完，或之后又投出一份）：预准备跑完后，自动在对话里放一张勾选表。
 * 没有能投的、或者已经有一张在等他，就不出，不拿空表打扰他。
 */
export function proposeAfterSubmit(repos: Repos, store: CareerStore, post: PostChatCard, sessionId: string | null): boolean {
  if (hasOpenProposal(repos, sessionId)) return false;
  const p = proposeBatch(repos, store);
  if (!p.rows.some(r => r.picked)) return false;
  postCard(post, p, Date.now(), 'after-submit');
  return true;
}
