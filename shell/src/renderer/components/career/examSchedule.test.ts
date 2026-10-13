import { describe, expect, it } from 'vitest';

import { examRecords, examTimeStatus } from './examSchedule';
import type { Deadline, DossierSummary } from './types';

const NOW = new Date('2026-10-13T08:00:00.000Z');

const dl = (over: Partial<Deadline>): Deadline => ({
  id: 'd', kind: 'written_test', title: '笔试', due_at: '2026-10-14T06:00:00.000Z', application_id: null, job_id: null, interview_id: null, offer_id: null,
  source: 'mail', status: 'open', url: null, note: null, created_at: '2026-10-01', updated_at: '2026-10-01', ...over,
});
const summary = (over: Partial<DossierSummary>): DossierSummary => ({
  application_id: 'a1', job_id: 'j1', company_name: '丙公司', title: '后端工程师', stage: 'applied', updated_at: '2026-10-01', days_since_update: 1,
  next_deadline: null, interview_count: 0, resume_tailored_id: null, closed: false, ...over,
});

describe('examTimeStatus：只按时间和现在比', () => {
  it('没到 / 已过期 / 时间解析不了', () => {
    expect(examTimeStatus('2026-10-13T08:00:01.000Z', NOW)).toBe('upcoming');
    expect(examTimeStatus('2026-10-13T07:59:59.000Z', NOW)).toBe('expired');
    expect(examTimeStatus('不是时间', NOW)).toBe('unknown');
    expect(examTimeStatus(null, NOW)).toBe('unknown');
  });
});

describe('examRecords：截止事件 → 笔试记录行', () => {
  it('只要笔试 / 测评；已取消的不列；按投递 / 岗位补公司和岗位；没到的在前（正序），过期的在后（倒序）', () => {
    const rows = examRecords([
      dl({ id: 'past1', due_at: '2026-10-10T06:00:00.000Z', application_id: 'a1', status: 'done' }),
      dl({ id: 'soon', due_at: '2026-10-14T06:00:00.000Z', kind: 'assessment', job_id: 'j2' }),
      dl({ id: 'later', due_at: '2026-10-20T06:00:00.000Z', title: '某司线上笔试' }),
      dl({ id: 'past2', due_at: '2026-10-12T06:00:00.000Z', application_id: 'a1', status: 'missed' }),
      dl({ id: 'cancelled', status: 'cancelled', application_id: 'a1' }),
      dl({ id: 'iv', kind: 'interview', application_id: 'a1' }),
    ], [summary({}), summary({ application_id: 'a2', job_id: 'j2', company_name: '丁公司', title: '算法工程师' })], NOW);
    expect(rows.map(r => r.id)).toEqual(['soon', 'later', 'past2', 'past1']);
    expect(rows.map(r => r.status)).toEqual(['upcoming', 'upcoming', 'expired', 'expired']);
    expect(rows[0]).toMatchObject({ company_name: '丁公司', title: '算法工程师', kind: 'assessment', application_id: 'a2' });
    // 关联不到投递时：公司未知，岗位用事件标题
    expect(rows[1]).toMatchObject({ company_name: null, title: '某司线上笔试', application_id: null });
    // 状态不看 deadline.status（done / missed 都只按时间算）
    expect(rows[2]).toMatchObject({ company_name: '丙公司', status: 'expired' });
  });
});
