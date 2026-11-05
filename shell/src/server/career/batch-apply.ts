/**
 * 框选一批、确认投出（世界模型 §6 立场 9；用户 2026-10-30「你这个框选一堆，然后你就直接确认」）。
 *
 *  - planJobs：确认之前先把这一批算清楚——几家能直接开始、几家标了星（填好后先给你看）、哪几家要跳过（带原因）、
 *    有没有要先选一份简历的（好几份主简历、又没有定制版）。要问的一次问完、给好选项，不逐家问。
 *  - applyJobs：一次确认 = 建投递冻结材料 + 批准开始 + 交给后台（网申 → 批量运行器；JD 写明发邮箱的 → 邮件起草器）；没有「待投清单」这一步（用户 10-30：选了就是要投），
 *    不经过对话，也不用再去别处点「开始」。岗位页「开始投」和对话里的 jobs_apply 都走这里。
 *  - startApprovedFills：批准了的填表一律交后台运行器（岗位页、等你条、对话里的卡片都走这里），助理不再逐份 apply_run。
 *  - prepareAhead：预准备（主线体验 ⑥，face-pipeline 2e）——他看着一份做通、在提交卡上点了头之后，后台把方向对得上的
 *    几家先定制、填到提交前停住；他回来看到「备好了 N 家」，点一下就交。提交前一律停，没他点头不交（放过权的那一类除外）。
 */
import { applyChannelOf, extractApplyEmail, type ActionQueueItem, type Repos } from '@career/core';

import { isSubmittedStage } from '../../shared/careerStages';
import { ACTIVE_ACTION_STATUSES, isStartAction } from './apply-actions';
import { BatchRunner } from './batch-runner';
import { getJobPrefs, jobBoard, NO_APPLY_ROUTE_REASON, prepareJobs } from './job-board';
import { kickMailDrafter } from './mail-apply/runner';
import { pickResumeForJob, type PacketDeps } from './packets';
import type { CareerStore } from './store';
import { markedTargetJobs } from './targets';

type Deps = PacketDeps & { store: CareerStore };

export interface JobPlan {
  /** 确认后会开始的岗位。 */
  ready: string[];
  /** ready 里标了星的：填好后先给你看，不进一键投出。 */
  targets: number;
  skipped: Array<{ job_id: string; reason: string }>;
  /** ready 里没有定制版、主简历又不止一份的：确认时选一份统一用。 */
  needs_resume: string[];
  resumes: Array<{ id: string; name: string }>;
}

function skipReason(repos: Repos, store: CareerStore, jobId: string, busyApps: ReadonlySet<string>): string | null {
  const job = repos.getJob(jobId);
  if (!job) return '岗位不存在';
  const apps = repos.listApplications().filter(a => a.job_id === jobId);
  if (apps.some(a => isSubmittedStage(a.stage))) return '已经投过';
  if (apps.some(a => busyApps.has(a.id))) return '已在投';
  if (!applyChannelOf(job)) return NO_APPLY_ROUTE_REASON;
  if (!store.listResumeMasters().length && !pickResumeForJob(store, jobId)) return '还没有简历';
  return null;
}

/**
 * 投递邮箱懒补（老数据不跑回填脚本）：判断通道前，对还没投递邮箱、有 JD 原文的岗位按规则认一次并落库。
 * 返回补上的个数。日志只记收件域名，不记全址。
 */
export function backfillApplyEmails(repos: Repos, jobIds: readonly string[]): number {
  let n = 0;
  for (const id of new Set(jobIds)) {
    const job = repos.getJob(id);
    if (!job || job.apply_email || !job.jd_raw) continue;
    const hit = extractApplyEmail(job.jd_raw);
    if (!hit) continue;
    repos.db.update('job', id, { apply_email: hit.email, updated_at: new Date().toISOString() });
    console.log(`[career] apply-email found job=${id} domain=${hit.email.split('@').pop() ?? ''}`);
    n++;
  }
  return n;
}

export function planJobs(repos: Repos, store: CareerStore, jobIds: readonly string[]): JobPlan {
  backfillApplyEmails(repos, jobIds);
  // 「已在投」按投递上所有在办的动作看（填表、提交、写邮件、发邮件都算），不按种类过滤
  const busyApps = new Set(repos.listActions().filter(a => ACTIVE_ACTION_STATUSES.has(a.status) && a.application_id).map(a => a.application_id!));
  const marked = markedTargetJobs(repos);
  const plan: JobPlan = { ready: [], targets: 0, skipped: [], needs_resume: [], resumes: [] };
  for (const id of new Set(jobIds)) {
    const reason = skipReason(repos, store, id, busyApps);
    if (reason) { plan.skipped.push({ job_id: id, reason }); continue; }
    plan.ready.push(id);
    if (marked.has(id)) plan.targets++;
    if (!pickResumeForJob(store, id)) plan.needs_resume.push(id);
  }
  if (plan.needs_resume.length) plan.resumes = store.listResumeMasters().map(r => ({ id: r.id, name: r.name }));
  return plan;
}

/** 批准了的填表交给后台批量运行器（命令写 kv，Global 侧车几秒内接走）；返回交出去的动作 id。 */
export function startApprovedFills(repos: Repos, actions: readonly Pick<ActionQueueItem, 'id' | 'kind'>[], by: string): string[] {
  const ids = actions.filter(a => a.kind === 'fill_form').map(a => a.id);
  if (ids.length) BatchRunner.command(repos, 'run', by, ids);
  return ids;
}

/** 批准了的写邮件交给后台邮件起草器（Global 侧车轮询库里的 approved draft_mail；同进程时当场踢一下）；返回交出去的动作 id。 */
export function startApprovedDrafts(actions: readonly Pick<ActionQueueItem, 'id' | 'kind'>[]): string[] {
  const ids = actions.filter(a => a.kind === 'draft_mail').map(a => a.id);
  if (ids.length) kickMailDrafter();
  return ids;
}

/** started：开始了的动作 id（填表 + 写邮件）；mails：其中几封是邮件（收起那一行说「其中 N 封邮件在写」）。 */
export type ApplyResult = { started: string[]; skipped: Array<{ job_id: string; reason: string }>; mails: number };

export interface ApplyOptions {
  /** 他对这封投递邮件的要求（对话里 mail_compose），交给后台写邮件时用。 */
  notes?: string | null;
}

/**
 * 一次确认就开始：按 plan 只投能投的那几家；有好几份主简历时用 resumeId 统一（定制版仍优先）。
 * 按通道分两堆：网申那堆交批量运行器填表；JD 写明发邮箱的那堆交邮件起草器写邮件（不占浏览器，两边互不等待）。
 * resumeId 缺省而又有要选简历的岗位，那几家照常跳过并说明原因（界面会先问，这里只兜住直接调用的）。
 */
export async function applyJobs(deps: Deps, jobIds: readonly string[], resumeId?: string | null, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const plan = planJobs(deps.repos, deps.store, jobIds);
  const results = plan.ready.length ? await prepareJobs(deps, plan.ready, null, { fallbackResumeId: resumeId ?? null, notes: opts.notes }) : [];
  const actions = results.filter(r => r.ok && r.action_id).map(r => deps.repos.getAction(r.action_id!)).filter((a): a is ActionQueueItem => !!a);
  deps.repos.reviewActions(actions.map(a => a.id), 'approved', 'user');
  const fills = startApprovedFills(deps.repos, actions, 'board');
  const drafts = startApprovedDrafts(actions);
  const failed = results.filter(r => !r.ok).map(r => ({ job_id: r.job_id, reason: r.reason ?? '没能开始' }));
  return { started: [...fills, ...drafts], skipped: [...plan.skipped, ...failed], mails: drafts.length };
}

/** 预准备一次最多备几家：够他回来点一下就交一批，又不会让没被选中的备料白跑太多（反方意见：备了不投就是浪费）。 */
export const PREPARE_AHEAD_LIMIT = 5;

/** 方向对得上、还没投也没在投的岗位，按匹配排前 limit 家，定制并填到提交前。返回开始备的填表动作。 */
export async function prepareAhead(deps: Deps, limit = PREPARE_AHEAD_LIMIT): Promise<string[]> {
  const keywords = (getJobPrefs(deps.repos).keywords ?? []).map(k => k.toLowerCase());
  if (!keywords.length || !deps.store.listResumeMasters().length) return [];
  // 在途：网申填表与写邮件都算（邮件岗位也预备，写到发前停住）
  const inFlight = deps.repos.listActions().filter(a => isStartAction(a) && ACTIVE_ACTION_STATUSES.has(a.status)).length;
  if (inFlight >= limit) return [];
  const picks = jobBoard(deps.repos, { open_only: true, fits_only: true, sort: 'match' })
    .filter(r => !r.application && keywords.some(k => `${r.job.title} ${r.job.jd_raw ?? ''}`.toLowerCase().includes(k)))
    .map(r => r.job.id);
  // 先过一遍能不能开始（没写怎么投、已在投的不备），再取前几家
  const ready = planJobs(deps.repos, deps.store, picks).ready.slice(0, limit - inFlight);
  if (!ready.length) return [];
  const results = await prepareJobs(deps, ready, null, { fallbackResumeId: null });
  const actions = results.filter(r => r.ok && r.action_id).map(r => deps.repos.getAction(r.action_id!)).filter((a): a is ActionQueueItem => !!a);
  deps.repos.reviewActions(actions.map(a => a.id), 'approved', 'system');
  const failed = results.filter(r => !r.ok);
  if (failed.length) console.warn(`[career] prepare-ahead skipped ${failed.length}: ${failed.map(r => `${r.job_id}:${r.reason ?? '?'}`).join('; ')}`);
  console.log(`[career] prepare-ahead started=${actions.length} candidates=${picks.length}`);
  return [...startApprovedFills(deps.repos, actions, 'prepare'), ...startApprovedDrafts(actions)];
}
