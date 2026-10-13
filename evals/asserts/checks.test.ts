import { describe, it, expect } from 'vitest'
// @ts-expect-error 纯 JS 断言模块，没有类型声明
import { noFabrication, respectsHardConditions, questionsGrounded, gradingCorrect } from './checks.mjs'

// 评测断言自身的单测：不需要模型 Key，随 pnpm test 跑。

describe('评测断言', () => {
  it('noFabrication：未标记的编造算失败，被编造检测标出的放过', () => {
    const vars = { forbidden: ['Spark', '负责人'] }
    expect(noFabrication({ changes: [{ path: '/x', value: '用 SQL 出周报' }], truthfulnessFlags: [] }, { vars }).pass).toBe(true)
    expect(noFabrication({ changes: [{ path: '/x', value: '用 Spark 处理数据' }], truthfulnessFlags: [] }, { vars }).pass).toBe(false)
    expect(noFabrication({ changes: [{ path: '/x', value: '用 Spark 处理数据' }], truthfulnessFlags: [{ kind: 'term', token: 'spark' }, { kind: 'term', token: 'Spark' }] }, { vars }).pass).toBe(true)
  })
  it('respectsHardConditions：该拦的要拦，不该拦的不能误杀', () => {
    expect(respectsHardConditions({ prefilter: { pass: false }, verdict: 'prefilter_fail' }, { vars: { expect_prefilter_fail: true } }).pass).toBe(true)
    expect(respectsHardConditions({ prefilter: { pass: true }, verdict: 'good' }, { vars: { expect_prefilter_fail: true, violation: '届别' } }).pass).toBe(false)
    expect(respectsHardConditions({ prefilter: { pass: false }, verdict: 'prefilter_fail' }, { vars: { expect_prefilter_fail: false } }).pass).toBe(false)
  })
  it('questionsGrounded：多数题要对应 JD / 经历，不能给标准答案', () => {
    const vars = { jd_terms: ['SQL'], resume_terms: ['周报'] }
    const qs = (n: number, grounded: number) => ({ questions: Array.from({ length: n }, (_, i) => ({ question: i < grounded ? '讲讲你写 SQL 的经历' : '你的爱好是什么', jd_requirement: '' })) })
    expect(questionsGrounded(qs(8, 6), { vars }).pass).toBe(true)
    expect(questionsGrounded(qs(8, 2), { vars }).pass).toBe(false)
    expect(questionsGrounded({ questions: [...qs(6, 6).questions, { question: 'SQL 题', note: '标准答案：……' }] }, { vars }).pass).toBe(false)
  })
  it('gradingCorrect：逐题对照', () => {
    expect(gradingCorrect({ review: [{ index: 0, verdict: '错' }, { index: 1, verdict: '对' }] }, { vars: { expected: ['错', '对'] } }).pass).toBe(true)
    expect(gradingCorrect({ review: [{ index: 0, verdict: '对' }, { index: 1, verdict: '对' }] }, { vars: { expected: ['错', '对'] } }).pass).toBe(false)
  })
})
