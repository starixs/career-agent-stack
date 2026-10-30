/**
 * 面试记录挂到哪一场：邀请、提醒、改期邮件和复盘说的常是同一场面试，要落回同一条 interview 和同一个时间点，
 * 不能每来一封、每复盘一次就多建一场。「同一场」= 同一份申请 + 同一轮次 + 还没复盘过。
 */
import type { Interview, Repos } from '@career/core';

import type { CareerStore } from './store';

/** 这份申请里这一轮还没复盘的那场（最新的一场）。 */
export function findOpenInterview(store: CareerStore, applicationId: string, round: string): Interview | undefined {
  return store.listInterviews().find(i => i.application_id === applicationId && i.round === round && !i.retro_json);
}

/** 邀请 / 提醒 / 改期：已有同一场就更新时间，没有才新建。返回这场面试与是否复用。 */
export function upsertInvitedInterview(
  store: CareerStore,
  input: { application_id: string; company_name: string | null; title: string | null; round: string; date: string | null },
): { interview: Interview; reused: boolean } {
  const existing = findOpenInterview(store, input.application_id, input.round);
  if (!existing) return { interview: store.createInterview(input), reused: false };
  const interview = input.date && input.date !== existing.date ? store.updateInterview(existing.id, { date: input.date }) : existing;
  return { interview, reused: true };
}

/** 这场面试仍打开的时间点（open / 已过期未处理）。 */
export function openInterviewDeadline(repos: Repos, interviewId: string) {
  return repos.listDeadlines({ status: 'open_or_missed' }).find(d => d.interview_id === interviewId);
}

/** 改期：把这场面试已有的时间点挪到新时间；过期了的改到将来重新打开。 */
export function rescheduleDeadline(repos: Repos, deadlineId: string, dueAt: string): void {
  const status = Date.parse(dueAt) > Date.now() ? 'open' : undefined;
  repos.db.update('deadline', deadlineId, { due_at: dueAt, ...(status ? { status } : {}), updated_at: new Date().toISOString() });
}

/**
 * 面试准备用哪版简历：用户点名的 > 这个岗位投出去的那版（面试官手里的就是它）> 没有就返回 undefined（调用方退回经历库）。
 */
export function interviewResume(store: CareerStore, repos: Repos, input: { resume_id?: string; job_id?: string }): ReturnType<CareerStore['getResume']> {
  if (input.resume_id) return store.getResume(input.resume_id);
  if (!input.job_id) return undefined;
  const sent = repos.listApplications().find(a => a.job_id === input.job_id && a.resume_tailored_id)?.resume_tailored_id;
  return sent ? store.getResume(sent) : undefined;
}

/**
 * 复盘写到哪一场：给了 interview_id 就用它；否则按公司找进行中的申请（唯一，或岗位名对得上），
 * 再取这份申请里这一轮（没说轮次就取最近一场）还没复盘的面试。找到申请但没有面试记录时，只返回申请，由调用方新建并挂上。
 */
export function retroTarget(
  store: CareerStore, repos: Repos,
  input: { interview_id?: string; company_name?: string; title?: string; round?: string },
): { interview_id?: string; application_id?: string } {
  if (input.interview_id) return { interview_id: input.interview_id };
  if (!input.company_name) return {};
  const hits = repos.findOpenApplicationsByCompany(input.company_name);
  const app = hits.length === 1 ? hits[0] : hits.find(a => input.title && a.job.title === input.title);
  if (!app) return {};
  const itv = input.round
    ? findOpenInterview(store, app.id, input.round)
    : store.listInterviews().find(i => i.application_id === app.id && !i.retro_json);
  return { interview_id: itv?.id, application_id: app.id };
}
