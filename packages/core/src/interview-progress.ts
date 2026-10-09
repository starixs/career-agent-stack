/**
 * 经历访谈进度（R03 从零写简历与对话挖掘经历）：
 * 六轮普查（教育 → 课程项目 → 实习 → 校园 → 比赛与个人项目 → 技能证书）每轮的状态 + 下一轮要问的问题，
 * 存 kv `experience:interview`，跨对话延续；再从经历库算出"还缺什么"（没有确认主张的经历、缺量化结果的主张、待确认数）。
 */
import type { Claim, Experience } from './types.js'

export const INTERVIEW_ROUNDS = [
  { key: 'education', label: '教育' },
  { key: 'course_project', label: '课程项目' },
  { key: 'internship', label: '实习' },
  { key: 'campus', label: '校园' },
  { key: 'competition_personal', label: '比赛与个人项目' },
  { key: 'skills', label: '技能证书' },
] as const
export type InterviewRound = typeof INTERVIEW_ROUNDS[number]['key']
/** todo 还没聊 / in_progress 在聊 / done 聊完 / none 用户确实没有（降级问过两次） */
export type RoundStatus = 'todo' | 'in_progress' | 'done' | 'none'
export const INTERVIEW_STATE_KEY = 'experience:interview'

export interface InterviewState {
  rounds: Partial<Record<InterviewRound, RoundStatus>>
  current_round?: InterviewRound | null
  current_experience_id?: string | null
  follow_up_questions?: string[]
  updated_at?: string
}

export interface InterviewProgress {
  rounds: Array<{ key: InterviewRound; label: string; status: RoundStatus }>
  done: number
  next_round: InterviewRound | null
  current_experience_id: string | null
  follow_up_questions: string[]
  gaps: {
    experiences_without_confirmed: Array<{ id: string; title: string }>
    claims_without_metric: Array<{ id: string; text: string; experience: string }>
    pending_claims: number
  }
  /** 一句话：现在最该做什么。 */
  suggestion: string
}

export function interviewProgress(tree: Array<Experience & { claims: Claim[] }>, state: InterviewState = { rounds: {} }): InterviewProgress {
  const rounds = INTERVIEW_ROUNDS.map(r => ({ key: r.key, label: r.label, status: state.rounds[r.key] ?? 'todo' as RoundStatus }))
  const done = rounds.filter(r => r.status === 'done' || r.status === 'none').length
  const next = state.current_round && rounds.find(r => r.key === state.current_round)?.status === 'in_progress' ? state.current_round : rounds.find(r => r.status === 'todo' || r.status === 'in_progress')?.key ?? null
  const withoutConfirmed = tree.filter(e => !e.claims.some(c => c.status !== 'pending')).map(e => ({ id: e.id, title: e.title }))
  const noMetric = tree.flatMap(e => e.claims.filter(c => c.status !== 'pending' && !c.result_metric && !/\d/.test(c.text)).map(c => ({ id: c.id, text: c.text, experience: e.title })))
  const pending = tree.reduce((n, e) => n + e.claims.filter(c => c.status === 'pending').length, 0)
  const nextLabel = INTERVIEW_ROUNDS.find(r => r.key === next)?.label
  const suggestion = pending > 0 ? `先确认 ${pending} 条待确认的主张（没确认的不会进简历）`
    : next ? `继续「${nextLabel}」这一轮访谈`
      : noMetric.length ? `给 ${noMetric.length} 条主张补上量化结果（数据量、人数、提升幅度）`
        : withoutConfirmed.length ? `「${withoutConfirmed[0].title}」还没有确认过的主张`
          : '六轮都聊完了，可以起草主简历'
  return {
    rounds, done, next_round: next, current_experience_id: state.current_experience_id ?? null, follow_up_questions: state.follow_up_questions ?? [],
    gaps: { experiences_without_confirmed: withoutConfirmed, claims_without_metric: noMetric.slice(0, 20), pending_claims: pending }, suggestion,
  }
}
