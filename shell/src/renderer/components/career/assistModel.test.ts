import { describe, expect, it } from 'vitest';

import { assistRecords, filterAssists } from './assistModel';
import type { Deadline, DossierSummary, ExamPractice, Interview, MockInterview } from './types';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const summary = (id: string, company: string, title: string) => ({ application_id: `a-${id}`, job_id: `j-${id}`, company_name: company, title } as DossierSummary);
const deadline = (id: string, kind: Deadline['kind'], due_at: string, app: string, status: Deadline['status'] = 'open') =>
  ({ id, kind, title: id, due_at, application_id: app, job_id: null, interview_id: null, offer_id: null, source: 'manual', status, url: null, note: null, created_at: '', updated_at: '' } as Deadline);

describe('assistRecords', () => {
  const src = {
    dossiers: [summary('1', '甲', '后端'), summary('2', '乙', '算法')],
    deadlines: [
      deadline('d1', 'written_test', '2026-10-20T06:00:00.000Z', 'a-1'),
      deadline('d2', 'assessment', '2026-10-10T06:00:00.000Z', 'a-2'),
      deadline('d3', 'interview', '2026-10-18T06:00:00.000Z', 'a-1'),
      deadline('d4', 'written_test', '2026-10-21T06:00:00.000Z', 'a-1', 'cancelled'),
    ],
    interviews: [{ id: 'i1', application_id: 'a-2', company_name: '乙', title: '算法', round: 'final', date: '2026-10-17T06:00:00.000Z' } as Interview],
    mocks: [{ id: 'm1', job_id: 'j-1', mode: 'probe', round: null, created_at: '2026-10-12T06:00:00.000Z' } as MockInterview],
    practices: [{ id: 'p1', title: '某厂笔试题', company_name: '丙', questions_json: '[1,2,3]', answers_json: '[1]', status: 'answering', updated_at: '2026-10-14T06:00:00.000Z' } as ExamPractice],
  };

  it('五类合成一张表：没到的按时间正序在前，其余倒序；面试时间事件不重复列（面试表里已有）', () => {
    const rows = assistRecords(src, NOW);
    expect(rows.map(r => r.key)).toEqual(['interview:i1', 'deadline:d1', 'practice:p1', 'mock:m1', 'deadline:d2']);
    expect(rows.find(r => r.key === 'mock:m1')).toMatchObject({ company_name: '甲', title: '后端', application_id: 'a-1', detail: '深挖追问' });
    expect(rows.find(r => r.key === 'practice:p1')?.detail).toBe('已答 1 / 3');
    expect(rows.find(r => r.key === 'interview:i1')?.detail).toBe('终面');
    expect(rows.find(r => r.key === 'deadline:d2')?.detail).toBe('已过');
  });

  it('筛选：笔试含测评和笔试练习', () => {
    const rows = assistRecords(src, NOW);
    expect(filterAssists(rows, 'exam').map(r => r.type)).toEqual(['written_test', 'exam_practice', 'assessment']);
    expect(filterAssists(rows, 'interview').map(r => r.id)).toEqual(['i1']);
    expect(filterAssists(rows, 'mock').map(r => r.id)).toEqual(['m1']);
    expect(filterAssists(rows, 'all')).toHaveLength(5);
  });
});
