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
