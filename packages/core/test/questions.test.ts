import { describe, it, expect } from 'vitest'
import { Db, Repos, questionKey } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('题库', () => {
  it('同一道题只存一条：标点空白不同也算同一题；面试题按公司区分', () => {
    expect(questionKey('请做一下自我介绍。', 'interview', '甲')).toBe(questionKey('请做一下 自我介绍', 'interview', '甲'))
    expect(questionKey('请做一下自我介绍', 'interview', '甲')).not.toBe(questionKey('请做一下自我介绍', 'interview', '乙'))
    expect(questionKey('1+1=?', 'written', '甲')).toBe(questionKey('1+1=?', 'written', '乙'))
  })

  it('按 JD 生成的题后来在真实面试里遇到：升级为"我见过的"，计次，来源累加', () => {
    const r = mem()
    const g = r.upsertQuestion({ content: '讲一个你用数据推动决策的例子', company_name: '甲', source: 'generated', source_ref: 'generated:job_1', category: 'project', probe_points: ['数据口径'] })
    expect(g.seen_count).toBe(0)
    const s = r.upsertQuestion({ content: '讲一个你用数据推动决策的例子。', company_name: '甲', source: 'seen', source_ref: 'interview:int_1' })
    expect(s.id).toBe(g.id)
    expect(s.source).toBe('seen')
    expect(s.seen_count).toBe(1)
    expect(JSON.parse(s.sources_json)).toEqual(['generated:job_1', 'interview:int_1'])
    // 再生成一次不会把"见过"降级
    expect(r.upsertQuestion({ content: '讲一个你用数据推动决策的例子', company_name: '甲', source: 'generated' }).source).toBe('seen')
    expect(r.listQuestions({ source: 'seen' })).toHaveLength(1)
  })

  it('作答记录绑定简历与岗位；最近 / 最好得分；只看薄弱题', () => {
    const r = mem()
    const q = r.upsertQuestion({ content: '为什么选择我们公司', source: 'generated' })
    const q2 = r.upsertQuestion({ content: '说说你的缺点', source: 'generated' })
    r.recordAttempt({ question_id: q.id, mode: 'mock', answer_text: '因为……', score: 45, resume_id: 'rsm_1', job_id: 'job_1' })
    r.recordAttempt({ question_id: q.id, mode: 'mock', answer_text: '因为……（改进）', score: 82, resume_id: 'rsm_1', job_id: 'job_1' })
    r.recordAttempt({ question_id: q2.id, score: 120 })
    const after = r.getQuestion(q.id)!
    expect(after).toMatchObject({ attempt_count: 2, last_attempt_score: 82, best_attempt_score: 82 })
    expect(r.getQuestion(q2.id)!.last_attempt_score).toBe(100)
    expect(r.listAttempts(q.id).map(a => a.score)).toEqual([45, 82])
    const r2 = r.upsertQuestion({ content: '还没练过的题', source: 'public' })
    expect(r.listQuestions({ weak_only: true }).map(x => x.id)).toEqual([r2.id])
  })
})
