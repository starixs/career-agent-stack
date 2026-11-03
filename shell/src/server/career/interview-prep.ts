/**
 * 「帮我准备」的终态：一张面试准备卡，只放最可能出事的少数几条（面试面页 · 等你定 5）：
 * 时间、上一轮 / 同类面试卡在哪、三个高风险深挖点、几道题、「开始模拟」。
 * 只读已有记录（预测、题库、复盘）拼出来，不调模型；缺的部分由助理先调 interview_predict / interview_questions 补。
 */
import type { Interview, Repos } from '@career/core';

import { carryoverFor } from './interview-carry';
import { interviewResume } from './interview-link';
import type { CareerStore } from './store';

/** 卡片上各放几条：前一晚要的是最可能出事的那几条。 */
const MAX_PREDICTIONS = 3;
const MAX_QUESTIONS = 5;
const RISK_ORDER: Record<string, number> = { high: 0, mid: 1, medium: 1, low: 2 };

export interface InterviewPrep {
  application_id: string; job_id: string; interview_id: string | null;
  company: string | null; title: string; round: string | null; at: string | null;
  carried: Array<{ company: string | null; round: string; same_application: boolean; points: string[] }>;
  predictions: Array<{ statement: string; risk: string; chain: string[] }>;
  questions: Array<{ id: string; content: string; last_score: number | null }>;
  missing: Array<'predictions' | 'questions'>;
}

/** 这份申请接下来那场面试（还没复盘、时间最近的）；都过了就取最近一场。 */
function nextInterview(store: CareerStore, applicationId: string, nowIso: string): Interview | undefined {
  const open = store.listInterviews().filter(i => i.application_id === applicationId && !i.retro_json);
  const upcoming = open.filter(i => i.date && i.date >= nowIso).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return upcoming[0] ?? open[0];
}

function chainOf(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch (error) {
    console.warn('[career] interview prep: expected_chain_json 不是 JSON:', error instanceof Error ? error.message : error);
    return [];
  }
}

export function buildInterviewPrep(store: CareerStore, repos: Repos, applicationId: string, nowIso = new Date().toISOString()): InterviewPrep {
  const app = repos.getApplication(applicationId);
  if (!app) throw new Error(`投递不存在：${applicationId}`);
  const job = repos.getJob(app.job_id);
  if (!job) throw new Error(`岗位不存在：${app.job_id}`);
  const itv = nextInterview(store, app.id, nowIso);
  const carry = carryoverFor(store, repos, job, itv?.round);
  const resume = interviewResume(store, repos, { job_id: job.id });
  const preds = resume?.kind === 'tailored'
    ? repos.db.all<{ statement: string; risk: string; expected_chain_json: string }>('SELECT statement, risk, expected_chain_json FROM probe_prediction WHERE resume_tailored_id=? ORDER BY created_at DESC', [resume.row.id])
    : [];
  const predictions = [...preds].sort((a, b) => (RISK_ORDER[a.risk] ?? 1) - (RISK_ORDER[b.risk] ?? 1)).slice(0, MAX_PREDICTIONS)
    .map(p => ({ statement: p.statement, risk: p.risk, chain: chainOf(p.expected_chain_json) }));
  // 没练过 / 得分低的排前面
  const questions = repos.listQuestions({ job_id: job.id, kind: 'interview', limit: 50 })
    .sort((a, b) => (a.last_attempt_score ?? -1) - (b.last_attempt_score ?? -1)).slice(0, MAX_QUESTIONS)
    .map(q => ({ id: q.id, content: q.content, last_score: q.last_attempt_score }));
  return {
    application_id: app.id, job_id: job.id, interview_id: itv?.id ?? null, company: job.company_name, title: job.title, round: itv?.round ?? null, at: itv?.date ?? null,
    carried: carry.retros.map(r => ({ company: r.company, round: r.round, same_application: r.same_application, points: [r.focus, ...r.next_round_probes].filter((p): p is string => !!p) })),
    predictions, questions,
    missing: [...(predictions.length ? [] : ['predictions' as const]), ...(questions.length ? [] : ['questions' as const])],
  };
}

