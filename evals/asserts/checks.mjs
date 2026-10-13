/**
 * 评测断言（确定性，不调模型）。promptfoo 的 javascript 断言调用这些函数；同时有 vitest 单测保证断言本身是对的。
 * 每个函数返回 { pass, score, reason }。
 */

const parse = output => (typeof output === 'string' ? JSON.parse(output) : output)

/** 简历改写：不得出现原文与已确认主张里没有的数字 / 机构 / 头衔 / 技术词（产品的编造检测必须把它们标出来或拦下）。 */
export function noFabrication(output, { vars }) {
  const o = parse(output)
  const forbidden = vars.forbidden ?? []
  const text = JSON.stringify(o.changes ?? [])
  const leaked = forbidden.filter(t => text.includes(t) && !(o.truthfulnessFlags ?? []).some(f => String(f.token).includes(t) || t.includes(String(f.token))))
  return leaked.length
    ? { pass: false, score: 0, reason: `改写里出现了未经证实且没被标记的内容：${leaked.join('、')}` }
    : { pass: true, score: 1, reason: `${(o.changes ?? []).length} 处改动，没有未标记的编造` }
}

/** 岗位评估：违反用户明确条件（届别 / 城市 / 学历）时必须预筛不通过。 */
export function respectsHardConditions(output, { vars }) {
  const o = parse(output)
  const failed = o?.prefilter?.pass === false || o?.verdict === 'prefilter_fail'
  if (vars.expect_prefilter_fail) return failed ? { pass: true, score: 1, reason: '违反明确条件，已预筛不通过' } : { pass: false, score: 0, reason: `应当预筛不通过（${vars.violation}），实际 verdict=${o?.verdict}` }
  return failed ? { pass: false, score: 0, reason: '没有违反条件却被预筛掉了' } : { pass: true, score: 1, reason: '条件符合，未被误杀' }
}

/** 面试题：每题都要能追溯到 JD 要求或用户经历；不能给标准答案。 */
export function questionsGrounded(output, { vars }) {
  const o = parse(output)
  const qs = Array.isArray(o?.questions) ? o.questions : []
  if (qs.length < 5) return { pass: false, score: 0, reason: `题目太少：${qs.length}` }
  const anchors = [...(vars.jd_terms ?? []), ...(vars.resume_terms ?? [])]
  const grounded = qs.filter(q => anchors.some(a => `${q.question ?? ''}${q.jd_requirement ?? ''}`.includes(a)))
  const withAnswer = qs.filter(q => /标准答案|参考答案|答案[:：]/.test(JSON.stringify(q)))
  const ratio = grounded.length / qs.length
  if (withAnswer.length) return { pass: false, score: 0, reason: '给出了标准答案' }
  return ratio >= 0.6 ? { pass: true, score: ratio, reason: `${grounded.length}/${qs.length} 题对应到 JD 或经历` } : { pass: false, score: ratio, reason: `只有 ${grounded.length}/${qs.length} 题对应到 JD 或经历` }
}

/** 笔试批改：逐题 verdict 与期望一致。 */
export function gradingCorrect(output, { vars }) {
  const o = parse(output)
  const review = Array.isArray(o?.review) ? o.review : []
  const wrong = (vars.expected ?? []).filter((v, i) => review.find(r => r.index === i)?.verdict !== v)
  return wrong.length ? { pass: false, score: 1 - wrong.length / vars.expected.length, reason: `${wrong.length} 题判错：期望 ${JSON.stringify(vars.expected)}，实际 ${JSON.stringify(review.map(r => r.verdict))}` } : { pass: true, score: 1, reason: '逐题判定正确' }
}
