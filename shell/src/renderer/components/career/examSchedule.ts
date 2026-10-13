/**
 * 笔试记录：每场笔试 / 测评一行。时间来自截止事件（deadline.kind = written_test / assessment，due_at 是安排的时间；
 * 收件箱识别出笔试 / 测评邀请时会建这条事件）。笔试练习没有安排时间，不进这张表。
 *
 * 状态只分「未到 / 已过期」：只按时间和现在比，我们不知道用户到底去没去考。
 */
import type { Deadline, DossierSummary } from './types';

export type ExamTimeStatus = 'upcoming' | 'expired' | 'unknown';

export function examTimeStatus(dueAt: string | null | undefined, now: Date = new Date()): ExamTimeStatus {
  const ms = dueAt ? Date.parse(dueAt) : NaN;
  if (!Number.isFinite(ms)) return 'unknown';
  return ms < now.getTime() ? 'expired' : 'upcoming';
}

export interface ExamRecordRow {
  id: string; kind: 'written_test' | 'assessment'; company_name: string | null; title: string;
  due_at: string; status: ExamTimeStatus; url: string | null; application_id: string | null;
}

/** 截止事件 + 投递摘要 → 笔试记录行：没到的按时间正序在前，过期的按时间倒序在后；已取消的不列。 */
export function examRecords(deadlines: readonly Deadline[], summaries: readonly DossierSummary[], now: Date = new Date()): ExamRecordRow[] {
  const byApp = new Map(summaries.map(s => [s.application_id, s]));
  const byJob = new Map(summaries.map(s => [s.job_id, s]));
  const rows = deadlines
    .filter((d): d is Deadline & { kind: 'written_test' | 'assessment' } => (d.kind === 'written_test' || d.kind === 'assessment') && d.status !== 'cancelled')
    .map(d => {
      const s = (d.application_id ? byApp.get(d.application_id) : undefined) ?? (d.job_id ? byJob.get(d.job_id) : undefined);
      return {
        id: d.id, kind: d.kind, company_name: s?.company_name ?? null, title: s?.title ?? d.title,
        due_at: d.due_at, status: examTimeStatus(d.due_at, now), url: d.url, application_id: s?.application_id ?? d.application_id,
      };
    });
  const upcoming = rows.filter(r => r.status !== 'expired').sort((a, b) => a.due_at.localeCompare(b.due_at));
  const expired = rows.filter(r => r.status === 'expired').sort((a, b) => b.due_at.localeCompare(a.due_at));
  return [...upcoming, ...expired];
}
