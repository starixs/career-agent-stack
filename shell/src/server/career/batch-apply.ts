/**
 * 框选一批、确认投出（世界模型 §6 立场 9；用户 2026-10-30「你这个框选一堆，然后你就直接确认」）。
 *
 *  - planJobs：确认之前先把这一批算清楚——几家能直接开始、几家标了星（填好后先给你看）、哪几家要跳过（带原因）、
 *    有没有要先选一份简历的（好几份主简历、又没有定制版）。要问的一次问完、给好选项，不逐家问。
 *  - applyJobs：一次确认 = 建投递冻结材料 + 批准开始 + 交给后台批量运行器；没有「待投清单」这一步（用户 10-30：选了就是要投），
 *    不经过对话，也不用再去别处点「开始」。岗位页「开始投」和对话里的 jobs_apply 都走这里。
 *  - startApprovedFills：批准了的填表一律交后台运行器（岗位页、等你条、对话里的卡片都走这里），助理不再逐份 apply_run。
 *  - prepareAhead：预准备（主线体验 ⑥，face-pipeline 2e）——他看着一份做通、在提交卡上点了头之后，后台把方向对得上的
 *    几家先定制、填到提交前停住；他回来看到「备好了 N 家」，点一下就交。提交前一律停，没他点头不交（放过权的那一类除外）。
 */
import type { ActionQueueItem, Repos } from '@career/core';
import { buildAsks, type Vault } from '@career/core';

import { BatchRunner } from './batch-runner';
import { getJobPrefs, jobBoard, prepareJobs } from './job-board';
import { pickResumeForJob, type PacketDeps } from './packets';
import type { CareerStore } from './store';
import { markedTargetJobs } from './targets';

type Deps = PacketDeps & { store: CareerStore };

/** 还在投的投递上挂着这些状态的动作，就算「已在投」。 */
const ACTIVE_ACTION = new Set(['pending_review', 'approved', 'executing', 'needs_user']);
/** 投出去过的阶段（放弃 / 跳过的不算），与 job-board.prepareJobs 同口径。 */
const SENT = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);

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
  if (apps.some(a => SENT.has(a.stage))) return '已经投过';
  if (apps.some(a => busyApps.has(a.id))) return '已在投';
  if (!job.url) return '没有网申链接';
  if (!store.listResumeMasters().length && !pickResumeForJob(store, jobId)) return '还没有简历';
  return null;
}

export function planJobs(repos: Repos, store: CareerStore, jobIds: readonly string[]): JobPlan {
  const busyApps = new Set(repos.listActions().filter(a => ACTIVE_ACTION.has(a.status) && a.application_id).map(a => a.application_id!));
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

export type ApplyResult = { started: string[]; skipped: Array<{ job_id: string; reason: string }> };

/**
 * 一次确认就开始：按 plan 只投能投的那几家；有好几份主简历时用 resumeId 统一（定制版仍优先）。
 * resumeId 缺省而又有要选简历的岗位，那几家照常跳过并说明原因（界面会先问，这里只兜住直接调用的）。
 */
export async function applyJobs(deps: Deps, jobIds: readonly string[], resumeId?: string | null): Promise<ApplyResult> {
  const plan = planJobs(deps.repos, deps.store, jobIds);
  const results = plan.ready.length ? await prepareJobs(deps, plan.ready, null, { fallbackResumeId: resumeId ?? null }) : [];
  const actions = results.filter(r => r.ok && r.action_id).map(r => deps.repos.getAction(r.action_id!)).filter((a): a is ActionQueueItem => !!a);
  deps.repos.reviewActions(actions.map(a => a.id), 'approved', 'user');
  const started = startApprovedFills(deps.repos, actions, 'board');
  const failed = results.filter(r => !r.ok).map(r => ({ job_id: r.job_id, reason: r.reason ?? '没能开始' }));
  return { started, skipped: [...plan.skipped, ...failed] };
}

/** 预准备一次最多备几家：够他回来点一下就交一批，又不会让没被选中的备料白跑太多（反方意见：备了不投就是浪费）。 */
export const PREPARE_AHEAD_LIMIT = 5;

/** 方向对得上、还没投也没在投的岗位，按匹配排前 limit 家，定制并填到提交前。返回开始备的填表动作。 */
export async function prepareAhead(deps: Deps, limit = PREPARE_AHEAD_LIMIT): Promise<string[]> {
  const keywords = (getJobPrefs(deps.repos).keywords ?? []).map(k => k.toLowerCase());
  if (!keywords.length || !deps.store.listResumeMasters().length) return [];
  const inFlight = deps.repos.listActions().filter(a => a.kind === 'fill_form' && ACTIVE_ACTION.has(a.status)).length;
  if (inFlight >= limit) return [];
  const picks = jobBoard(deps.repos, { open_only: true, fits_only: true, sort: 'match' })
    .filter(r => !r.application && keywords.some(k => `${r.job.title} ${r.job.jd_raw ?? ''}`.toLowerCase().includes(k)))
    .map(r => r.job.id);
  // 先过一遍能不能开始（没网申链接、已在投的不备），再取前几家
  const ready = planJobs(deps.repos, deps.store, picks).ready.slice(0, limit - inFlight);
  if (!ready.length) return [];
  const results = await prepareJobs(deps, ready, null, { fallbackResumeId: null });
  const actions = results.filter(r => r.ok && r.action_id).map(r => deps.repos.getAction(r.action_id!)).filter((a): a is ActionQueueItem => !!a);
  deps.repos.reviewActions(actions.map(a => a.id), 'approved', 'system');
  const failed = results.filter(r => !r.ok);
  if (failed.length) console.warn(`[career] prepare-ahead skipped ${failed.length}: ${failed.map(r => `${r.job_id}:${r.reason ?? '?'}`).join('; ')}`);
  console.log(`[career] prepare-ahead started=${actions.length} candidates=${picks.length}`);
  return startApprovedFills(deps.repos, actions, 'prepare');
}

/** 回执里最多列几件等他的事的标题，多了只报数。 */
const WAITING_TITLES_MAX = 3;

/**
 * 这批刚开始的网申里，现在就已经在等他的事（缺的证件号、要他登录的站…）：给助理一个准数，
 * 让它说「有 N 件在右边等你」，而不是「填完跟我说一声」（10-17 实例：同一缺项让他回话六次）。
 */
export function waitingOnYou(repos: Repos, actionIds: readonly string[], nowIso: string): { count: number; titles: string[] } {
  const apps = new Set(actionIds.map(id => repos.getAction(id)?.application_id).filter((id): id is string => !!id));
  if (!apps.size) return { count: 0, titles: [] };
  const asks = buildAsks(repos, nowIso).filter(a => a.application_ids.some(id => apps.has(id)));
  return { count: asks.length, titles: asks.slice(0, WAITING_TITLES_MAX).map(a => a.title) };
}

/** 网申表单几乎都要、缺了就会停下来等他的基本资料（私密库字段名）。 */
const APPLY_CORE_PROFILE_FIELDS = ['name', 'phone', 'email', 'idNumber', 'school', 'major', 'degree', 'graduation'];

/**
 * 开投这一刻私密库里就缺的核心资料：后台填到这些格子时一定会停下来等他。
 * 刚开始投时 waitingOnYou 多半还是 0（缺项要填到那一页才发现），这里提前报，助理一次说清、在右边补一次，不让他反复回话。
 */
export function likelyMissingProfile(vault: Vault): string[] {
  const missing = new Map(vault.status().profile.missing.map(m => [m.field, m.label]));
  return APPLY_CORE_PROFILE_FIELDS.filter(f => missing.has(f)).map(f => missing.get(f)!);
}

