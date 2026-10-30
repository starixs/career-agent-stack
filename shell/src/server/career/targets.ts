/**
 * 目标岗位：值得重点打磨的少数申请（世界模型 §3.3「谁算目标」）。
 * 只有两种来源：进入过面试的申请自动算目标；用户亲手标的岗位。除此之外系统不替用户认定，也不按匹配分猜。
 *
 * 用户标记按岗位记（海投阶段可能还没建申请），存在 kv 里，不加表：几个面并行开发时避免迁移版本号相撞。
 */
import type { Repos } from '@career/core';

export const TARGET_JOBS_KEY = 'career.target_jobs';

export type TargetSource = 'interview' | 'user';

/** 用户亲手标成目标的岗位 id。 */
export function markedTargetJobs(repos: Repos): Set<string> {
  const raw = repos.kvGet<unknown>(TARGET_JOBS_KEY);
  return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
}

/** 标 / 取消标一个岗位；返回标记后的状态。取消只撤掉用户的标记，进过面试的仍算目标。 */
export function setTargetJob(repos: Repos, jobId: string, target: boolean): boolean {
  if (!repos.getJob(jobId)) throw new Error(`岗位不存在：${jobId}`);
  const marked = markedTargetJobs(repos);
  if (target) marked.add(jobId); else marked.delete(jobId);
  repos.kvSet(TARGET_JOBS_KEY, [...marked]);
  return target;
}

/** 一份申请算不算目标、为什么算：进过面试 > 用户标的 > 不算（null）。reachedStages 来自阶段历史。 */
export function targetSourceOf(app: { job_id: string; stage: string }, reachedStages: readonly string[], marked: ReadonlySet<string>): TargetSource | null {
  if (app.stage === 'interview' || app.stage === 'offer' || reachedStages.includes('interview')) return 'interview';
  if (marked.has(app.job_id)) return 'user';
  return null;
}
