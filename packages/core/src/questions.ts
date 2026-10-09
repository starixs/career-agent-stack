/** 题库：题目键与类型。 */
import { sha256 } from './keys.js'

export const QUESTION_KINDS = ['interview', 'written', 'assessment'] as const
export type QuestionKind = typeof QUESTION_KINDS[number]
export const QUESTION_SOURCES = ['public', 'seen', 'generated'] as const
export type QuestionSource = typeof QUESTION_SOURCES[number]
export const ATTEMPT_MODES = ['self', 'mock', 'written', 'real'] as const
export type AttemptMode = typeof ATTEMPT_MODES[number]

/** 题干归一：去空白与标点、全角转半角、小写；面试题按"公司 + 题干"区分（同一题不同公司分开记），笔试题只按题干。 */
export function normalizeQuestionText(content: string): string {
  return content.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}
export function questionKey(content: string, kind: QuestionKind = 'interview', company?: string | null): string {
  const base = normalizeQuestionText(content)
  return `${kind}:${sha256(kind === 'interview' && company ? `${company.trim().toLowerCase()}|${base}` : base).slice(0, 20)}`
}

export interface QuestionRow {
  id: string; question_key: string; kind: QuestionKind; category: string | null; content: string; reference: string | null; probe_points_json: string; jd_requirement: string | null
  company_name: string | null; title: string | null; job_id: string | null; source: QuestionSource; sources_json: string; tags_json: string
  seen_count: number; attempt_count: number; last_attempt_score: number | null; best_attempt_score: number | null; first_seen_at: string | null; last_seen_at: string | null; created_at: string; updated_at: string
}
export interface QuestionAttemptRow {
  id: string; question_id: string; mode: AttemptMode; answer_text: string | null; score: number | null; feedback_json: string
  resume_id: string | null; resume_snapshot_id: string | null; job_id: string | null; mock_interview_id: string | null; exam_id: string | null; interview_id: string | null; created_at: string
}
