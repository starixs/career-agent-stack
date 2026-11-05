/**
 * 批量勾选表的候选（face-beta-polish 2026-11-05：批量投的主入口 = 小芽提议一张勾选表）。
 *
 * 所有入口（第一份投出之后、建议条「再投 5 家」、右栏「再投一批」、功能市场、网申进展空状态）都汇到这里，
 * 出的是同一张 `batch_pick` 卡。只挑「现在就能开始」的岗位（planJobs 过一遍：没网申链接、已在投、已投过的不进表），
 * 默认勾前几家且一家公司只勾一个岗（怕同一家投多个岗被锁），标星的标「先给你看」，
 * 每行带上网申系统在信任账本里的状态（我会了 / 新的），让他知道哪几家会先停给他看。
 */
import type { Repos } from '@career/core';

import { applyJobs, planJobs } from './batch-apply';
import { settleChatCard, type PostChatCard } from './chat-card-push';
import { getJobPrefs, jobBoard, type BoardRow } from './job-board';
import type { PacketDeps } from './packets';
import type { CareerStore } from './store';
import { markedTargetJobs } from './targets';
import { systemOfSync, trustOf } from './trust-ledger';

/** 默认勾几家：一小批，看得过来（face-mainline「再投一小批」）。 */
export const BATCH_PICK_DEFAULT = 5;
/** 表里最多列几家：再多就不是"一眼看完"的一小批了，剩下的说个数。 */
export const BATCH_PICK_MAX_ROWS = 20;
export const BATCH_PICK_CARD_KIND = 'batch_pick';

export interface BatchPickRow {
  job_id: string;
  company: string;
  title: string;
  city: string | null;
  /** 网申系统的名字（北森、Moka…；认不出时按网站）。 */
  system: string | null;
  /** 这一类在他这儿投通过（shown / delegated）= true；没投过 = false，会先停给他看。 */
  known: boolean;
  /** 标了星：填好先给他看，不进一键投出。 */
  target: boolean;
  picked: boolean;
}

export interface BatchProposal {
  rows: BatchPickRow[];
  /** 能投但没列进表的家数。 */
  more: number;
  /** 方向（他说过的关键词），用于表头"按你的方向：…"。 */
  direction: string[];
  /** 统一用哪份主简历（没有定制版时）。 */
  resume: { id: string; name: string } | null;
  /** 挡住整批的原因：还没有简历时一家都开始不了，要如实说，不说成"没有能投的岗位"。 */
  blocked: 'no_resume' | null;
}

function toRow(r: BoardRow, marked: Set<string>, repos: Repos): Omit<BatchPickRow, 'picked'> {
  const sys = r.job.url ? systemOfSync(r.job.url) : null;
  const trust = sys ? trustOf(repos, sys.key) : 'new';
  return {
    job_id: r.job.id,
    company: r.job.company_name ?? '',
    title: r.job.title,
    city: r.job.location,
    system: sys?.label ?? null,
    known: trust !== 'new',
    target: marked.has(r.job.id) || r.target !== null,
  };
}

/** 一家公司只预勾一个岗，按顺序勾满 limit 家。 */
export function prePick<T extends { company: string }>(rows: T[], limit: number): Array<T & { picked: boolean }> {
  const seen = new Set<string>();
  let count = 0;
  return rows.map(row => {
    const key = row.company.trim() || '__unknown__';
    const picked = count < limit && !seen.has(key);
    if (picked) { seen.add(key); count += 1; }
    return { ...row, picked };
  });
}

/** 按他的方向挑出现在就能投的岗位。没方向时就按匹配排。 */
function candidates(repos: Repos): BoardRow[] {
  const keywords = (getJobPrefs(repos).keywords ?? []).map(k => k.toLowerCase());
  return jobBoard(repos, { open_only: true, fits_only: true, sort: 'match' })
    .filter(r => !r.application)
    .filter(r => !keywords.length || keywords.some(k => `${r.job.title} ${r.job.jd_raw ?? ''}`.toLowerCase().includes(k)));
}

export function proposeBatch(repos: Repos, store: CareerStore, limit = BATCH_PICK_DEFAULT): BatchProposal {
  const pool = candidates(repos);
  const plan = planJobs(repos, store, pool.map(r => r.job.id));
  const ready = new Set(plan.ready);
  const marked = markedTargetJobs(repos);
  const startable = pool.filter(r => ready.has(r.job.id));
  const rows = prePick(startable.slice(0, BATCH_PICK_MAX_ROWS).map(r => toRow(r, marked, repos)), limit);
  const master = store.listResumeMasters()[0];
  return {
    rows,
    more: Math.max(0, startable.length - rows.length),
    direction: getJobPrefs(repos).keywords ?? [],
    resume: master ? { id: master.id, name: master.name } : null,
    blocked: master ? null : 'no_resume',
  };
}

/** 卡片标题：一句问话，数字是默认勾的家数。 */
export function proposalTitle(p: BatchProposal): string {
  if (p.blocked === 'no_resume') return '投之前先要一份简历';
  const n = p.rows.filter(r => r.picked).length;
  return n ? `先投这 ${n} 家？` : '现在没有能直接投的岗位';
}

function postCard(post: PostChatCard, p: BatchProposal, now: number, why: 'asked' | 'after-submit'): void {
  post({ id: `batch-pick:${now}`, kind: BATCH_PICK_CARD_KIND, title: proposalTitle(p), data: { ...p } });
  console.log(`[career] batch-pick posted why=${why} rows=${p.rows.length} picked=${p.rows.filter(r => r.picked).length} more=${p.more}`);
}

/** 在对话里放一张勾选表。每次是新的一张（id 带时间），旧的那张留在对话里收着。 */
export function postProposal(repos: Repos, store: CareerStore, post: PostChatCard, now = Date.now()): { posted: boolean; picked: number } {
  const p = proposeBatch(repos, store);
  postCard(post, p, now, 'asked');
  return { posted: true, picked: p.rows.filter(r => r.picked).length };
}

/** 勾选表点了「投这 N 家」：开始投，并把卡收成"已开始投 N 家"。 */
export async function startFromCard(deps: PacketDeps & { store: CareerStore }, cardId: string, jobIds: string[], resumeId: string | null) {
  const res = await applyJobs(deps, jobIds, resumeId);
  const line = res.started.length
    ? `已开始投 ${res.started.length} 家${res.skipped.length ? `，${res.skipped.length} 家这次没开始` : ''}`
    : '这批一家都没能开始';
  settleChatCard(deps.repos, cardId, { done_line: line, started: res.started.length }, 'completed');
  return res;
}

/** 对话里已经有一张没处理的勾选表：不再自动出第二张。 */
export function hasOpenProposal(repos: Repos, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return repos.listChatCards(sessionId).some(c => c.kind === BATCH_PICK_CARD_KIND && c.state === 'pending');
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
