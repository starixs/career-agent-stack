/**
 * 助力记录：笔试、测评、面试、模拟面试、笔试练习合成一张表（2026-10-13 会议定，取代原来分开的笔试 / 面试 / Offer 记录）。
 * 列都一样：公司、岗位、时间、类型，最后一列是「助力」。
 *
 * 排序：有安排时间、还没到的按时间正序排在最前（马上要用的在上面）；其余按时间倒序。
 */
import { INTERVIEW_ROUND_LABELS, MOCK_MODE_LABELS } from './careerConstants';
import { examRecords } from './examSchedule';
import type { Deadline, DossierSummary, ExamPractice, Interview, MockInterview } from './types';

export type AssistType = 'written_test' | 'assessment' | 'interview' | 'mock_interview' | 'exam_practice';
/** 筛选只分三组：笔试（含测评、笔试练习）/ 面试 / 模拟面试。 */
export type AssistFilter = 'all' | 'exam' | 'interview' | 'mock';

export const ASSIST_TYPE_LABELS: Record<AssistType, string> = {
  written_test: '笔试', assessment: '测评', interview: '面试', mock_interview: '模拟面试', exam_practice: '笔试练习',
};

const FILTER_TYPES: Record<Exclude<AssistFilter, 'all'>, ReadonlySet<AssistType>> = {
  exam: new Set(['written_test', 'assessment', 'exam_practice']),
  interview: new Set(['interview']),
  mock: new Set(['mock_interview']),
};

export interface AssistRow {
  /** 类型前缀 + 原记录 id，跨表唯一。 */
  key: string;
  id: string;
  type: AssistType;
  company_name: string | null;
  title: string | null;
  /** 安排的时间（笔试 / 面试）或发生的时间（练习）；可能为空。 */
  at: string | null;
  /** 类型后面的补充：面试轮次、模拟模式、练习进度。 */
  detail: string | null;
  upcoming: boolean;
  application_id: string | null;
  url: string | null;
}

export interface AssistSources {
  deadlines: readonly Deadline[];
  dossiers: readonly DossierSummary[];
  interviews: readonly Interview[];
  mocks: readonly MockInterview[];
  practices: readonly ExamPractice[];
}

function isFuture(iso: string | null, now: Date): boolean {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) && ms >= now.getTime();
}

function countOf(json: string): number {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

export function assistRecords(src: AssistSources, now: Date = new Date()): AssistRow[] {
  const byJob = new Map(src.dossiers.map(s => [s.job_id, s]));
  const rows: AssistRow[] = [];

  for (const e of examRecords(src.deadlines, src.dossiers, now)) {
    rows.push({
      key: `deadline:${e.id}`, id: e.id, type: e.kind, company_name: e.company_name, title: e.title, at: e.due_at,
      detail: e.status === 'expired' ? '已过' : null, upcoming: e.status === 'upcoming', application_id: e.application_id, url: e.url,
    });
  }
  for (const iv of src.interviews) {
    const at = iv.date ?? null;
    rows.push({
      key: `interview:${iv.id}`, id: iv.id, type: 'interview', company_name: iv.company_name, title: iv.title, at,
      detail: INTERVIEW_ROUND_LABELS[iv.round] ?? iv.round, upcoming: isFuture(at, now), application_id: iv.application_id, url: null,
    });
  }
  for (const m of src.mocks) {
    const s = m.job_id ? byJob.get(m.job_id) : undefined;
    const round = m.round ? INTERVIEW_ROUND_LABELS[m.round] ?? m.round : null;
    rows.push({
      key: `mock:${m.id}`, id: m.id, type: 'mock_interview', company_name: s?.company_name ?? null, title: s?.title ?? m.company_type, at: m.created_at,
      detail: [MOCK_MODE_LABELS[m.mode] ?? m.mode, round].filter(Boolean).join(' · ') || null, upcoming: false, application_id: s?.application_id ?? null, url: null,
    });
  }
  for (const p of src.practices) {
    const total = countOf(p.questions_json);
    rows.push({
      key: `practice:${p.id}`, id: p.id, type: 'exam_practice', company_name: p.company_name, title: p.title, at: p.updated_at,
      detail: p.status === 'reviewed' ? '已批改' : `已答 ${countOf(p.answers_json)} / ${total}`, upcoming: false, application_id: null, url: null,
    });
  }

  const upcoming = rows.filter(r => r.upcoming).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const rest = rows.filter(r => !r.upcoming).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return [...upcoming, ...rest];
}

export function filterAssists(rows: readonly AssistRow[], filter: AssistFilter): AssistRow[] {
  return filter === 'all' ? [...rows] : rows.filter(r => FILTER_TYPES[filter].has(r.type));
}
