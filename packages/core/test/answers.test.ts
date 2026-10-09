import { describe, it, expect } from 'vitest'
import { Db, Repos, classifyAnswerSensitivity, normalizeQuestionKey } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('答案敏感度', () => {
  it('证件 / 密码 / 是否使用 AI / 反机器人 → excluded', () => {
    for (const q of ['身份证号码', '请输入登录密码', '短信验证码', '您在填写本申请时是否使用了 AI 工具？', '是否借助ChatGPT等生成式工具撰写回答', 'AI 辅助作答声明', 'Did you use AI to write this?', '机器人请勿填写此项'])
      expect(classifyAnswerSensitivity(q), q).toBe('excluded')
  })
  it('自我认同 / 个人信息 / 普通', () => {
    expect(classifyAnswerSensitivity('政治面貌')).toBe('self_id')
    expect(classifyAnswerSensitivity('民族')).toBe('self_id')
    expect(classifyAnswerSensitivity('手机号码')).toBe('personal')
    expect(classifyAnswerSensitivity('期望工作城市')).toBe('normal')
    expect(classifyAnswerSensitivity('你为什么想加入我们？')).toBe('normal')
    // "人工智能"作为专业 / 方向不是"是否使用 AI"
    expect(classifyAnswerSensitivity('你对人工智能行业的理解')).toBe('normal')
  })
  it('问题键归一化', () => {
    expect(normalizeQuestionKey('* 期望城市（必填）：')).toBe(normalizeQuestionKey('期望城市'))
    expect(normalizeQuestionKey('Expected  Salary?')).toBe('expected salary')
  })
})

describe('答案库治理', () => {
  it('excluded 问题不存、不记事件', () => {
    const r = mem()
    expect(r.saveAnswer({ question_key: '是否使用 AI 辅助填写', question_text: '是否使用 AI 辅助填写本表', answer: '否' })).toBeNull()
    expect(r.listAnswers()).toHaveLength(0)
    expect(r.pendingAnswerEvents()).toHaveLength(0)
  })

  it('改答案：旧的停用保留历史，记 edited 事件（带旧值）；同答案只刷新', () => {
    const r = mem()
    r.saveAnswer({ question_key: '期望城市', question_text: '期望城市', answer: '北京' })
    r.saveAnswer({ question_key: '期望城市', question_text: '期望城市', answer: '北京' })
    r.saveAnswer({ question_key: '* 期望城市：', question_text: '期望城市', answer: '上海' })
    expect(r.findAnswer('期望城市')!.answer).toBe('上海')
    expect(r.listAnswers()).toHaveLength(1)
    expect(r.listAnswers({ includeArchived: true })).toHaveLength(2)
    const evs = r.pendingAnswerEvents()
    expect(evs.map(e => e.kind)).toEqual(['answered', 'edited'])
    expect(evs[1]).toMatchObject({ answer: '上海', previous_value: '北京' })
  })

  it('固定优先；停用不再被取用；删除记事件', () => {
    const r = mem()
    const a = r.saveAnswer({ question_key: '到岗时间', question_text: '到岗时间', answer: '一周内' })!
    r.setAnswerStatus(a.id, 'pinned')
    // 学到新答案（如接管时用户在页面上填的）：固定状态跟随最新答案
    const b = r.saveAnswer({ question_key: '到岗时间', question_text: '到岗时间', answer: '两周内', source: 'learned' })!
    expect(b.status).toBe('pinned')
    expect(r.findAnswer('到岗时间')!.answer).toBe('两周内')
    r.setAnswerStatus(b.id, 'archived')
    expect(r.findAnswer('到岗时间')).toBeUndefined()
    r.deleteAnswer(b.id)
    expect(r.pendingAnswerEvents().map(e => e.kind)).toContain('deleted')
  })

  it('个人 / 自我认同类事件不带值', () => {
    const r = mem()
    r.saveAnswer({ question_key: '政治面貌', question_text: '政治面貌', answer: '共青团员' })
    const [ev] = r.pendingAnswerEvents()
    expect(ev.sensitivity).toBe('self_id')
    expect(ev.answer).toBeNull()
  })

  it('上传标记：成功后不再待传，失败保留待重试', () => {
    const r = mem()
    r.saveAnswer({ question_key: 'q1', question_text: '实习时长', answer: '6 个月' })
    r.saveAnswer({ question_key: 'q2', question_text: '每周到岗天数', answer: '5' })
    const [e1, e2] = r.pendingAnswerEvents()
    r.markAnswerEventsUploaded([e1.id])
    r.markAnswerEventsUploaded([e2.id], 'HTTP 500')
    expect(r.pendingAnswerEvents().map(e => e.id)).toEqual([e2.id])
  })
})
