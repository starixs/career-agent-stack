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

/** 复盘过 = 这场已经面完：它的时间点记为完成，不再以「已过期」顶到今日队列。返回是否关了一个。 */
export function closeInterviewDeadline(repos: Repos, interviewId: string): boolean {
  const open = openInterviewDeadline(repos, interviewId);
  if (!open) return false;
  repos.setDeadlineStatus(open.id, 'done');
  return true;
}

/** 电话 / 短信 / 微信约的面试：邮箱里没有，由用户自己记一场。 */
export interface BookedInterviewInput { company_name: string; title?: string | null; round?: string | null; when?: string | null; location?: string | null; note?: string | null; application_id?: string | null }

/**
 * 手动记一场面试：找到（或建好）这份申请，推进到面试，记面试与时间点；同一场再记一次只改时间。
 * 没说时间也先记上（时间点 due_at 为空 = 时间待定，今日队列提示去确认），不因为缺时间就挡住；之后补时间再记一次即可。
 * 返回申请、面试与时间点的 id。
 */
export function bookInterview(store: CareerStore, repos: Repos, input: BookedInterviewInput): { application_id: string; interview_id: string; deadline_id: string } {
  const company = input.company_name.trim();
  if (!company) throw new Error('请填写公司');
  const parsed = input.when ? new Date(input.when) : null;
  if (parsed && Number.isNaN(parsed.getTime())) throw new Error(`面试时间不是可解析的时间：${input.when}`);
  const dueIso = parsed?.toISOString() ?? null;
  const title = input.title?.trim() || null;
  const hits = repos.findOpenApplicationsByCompany(company);
  const found = input.application_id ? repos.getApplication(input.application_id) : hits.length === 1 ? hits[0] : hits.find(a => title && a.job.title === title);
  const base = found ?? repos.createApplication(repos.upsertJob({ source_platform: 'manual', title: title ?? '未命名岗位', company_name: company }).id);
  const app = repos.advanceTo(base.id, 'interview', '手动记了一场面试').app;
  const round = normalizeRoundLabel(input.round);
  const { interview } = upsertInvitedInterview(store, { application_id: app.id, company_name: company, title, round, date: dueIso });
  const known = openInterviewDeadline(repos, interview.id);
  if (known) { if (dueIso) rescheduleDeadline(repos, known.id, dueIso); return { application_id: app.id, interview_id: interview.id, deadline_id: known.id }; }
  const roundLabel = input.round?.trim() ? `（${input.round.trim()}）` : '';
  const deadline = repos.createDeadline({ kind: 'interview', title: `${company}${title ? ` · ${title}` : ''} 面试${roundLabel}`, due_at: dueIso, application_id: app.id, job_id: app.job_id, interview_id: interview.id, source: 'manual', url: input.location?.startsWith('http') ? input.location : null, note: [input.location && !input.location.startsWith('http') ? input.location : null, input.note].filter(Boolean).join('；') || null });
  return { application_id: app.id, interview_id: interview.id, deadline_id: deadline.id };
}

/** 「二面 / HR 面 / 终面」→ interview.round 的取值；和邮件归档同一套规则。 */
export function normalizeRoundLabel(round?: string | null): string {
  const r = (round ?? '').toLowerCase();
  if (['hr', 'first', 'second', 'final', 'group'].includes(r)) return r;
  if (/hr|人事/.test(r)) return 'hr';
  if (/一面|初面|first|1/.test(r)) return 'first';
  if (/二面|second|2/.test(r)) return 'second';
  if (/终面|final|三面/.test(r)) return 'final';
  if (/群面|group/.test(r)) return 'group';
  return 'other';
}

/**
 * 按公司名找「要准备的那份」申请：同一家几份在投时，有面试排着的那份就是它（能从数据补的不问）。
 * 还是分不出来才返回候选，由调用方列出来让用户点。
 */
export function applicationForInterview(repos: Repos, companyName: string): { application_id?: string; candidates: Array<{ application_id: string; label: string }> } {
  const hits = repos.findOpenApplicationsByCompany(companyName);
  if (hits.length <= 1) return { application_id: hits[0]?.id, candidates: [] };
  const withInterview = hits.filter(h => repos.listDeadlines({ status: 'open', application_id: h.id }).some(d => d.kind === 'interview'));
  if (withInterview.length === 1) return { application_id: withInterview[0].id, candidates: [] };
  const pool = withInterview.length ? withInterview : hits;
  return { candidates: pool.map(h => ({ application_id: h.id, label: `${h.job.company_name ?? '未知公司'} · ${h.job.title}` })) };
}
