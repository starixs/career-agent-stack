import { describe, it, expect } from 'vitest'
import { Db, Repos, interviewProgress } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('经历访谈进度', () => {
  it('六轮状态、下一轮、缺口与建议', () => {
    const r = mem()
    const e1 = r.createExperience({ title: '某电商数据实习' })
    const c1 = r.addClaim({ experience_id: e1.id, text: '搭建留存分析看板' }); r.confirmClaim(c1.id)
    r.addClaim({ experience_id: e1.id, text: '推动改版' })
    const e2 = r.createExperience({ title: '课程大作业' })
    let p = interviewProgress(r.experienceTree(), { rounds: { education: 'done', course_project: 'in_progress' }, current_round: 'course_project', follow_up_questions: ['几个人一组？'] })
    expect(p.done).toBe(1)
    expect(p.next_round).toBe('course_project')
    expect(p.follow_up_questions).toEqual(['几个人一组？'])
    expect(p.gaps.pending_claims).toBe(1)
    expect(p.gaps.experiences_without_confirmed.map(x => x.id)).toEqual([e2.id])
    expect(p.gaps.claims_without_metric.map(x => x.id)).toEqual([c1.id])
    expect(p.suggestion).toMatch(/待确认/)
    for (const c of r.listClaims()) r.confirmClaim(c.id)
    p = interviewProgress(r.experienceTree(), { rounds: Object.fromEntries(['education', 'course_project', 'internship', 'campus', 'competition_personal', 'skills'].map(k => [k, k === 'campus' ? 'none' : 'done'])) })
    expect(p.done).toBe(6)
    expect(p.next_round).toBeNull()
    expect(p.suggestion).toMatch(/量化/)
  })
})
