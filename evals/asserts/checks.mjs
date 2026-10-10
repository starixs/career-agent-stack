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

/**
 * 记忆提炼：克制（闲聊 / 一次性请求不记）、范围隔离（公司事实记在那家公司下，不串到别家）、
 * 更正（用 supersedes 或 forget 处理旧说法）、敏感不复述（个人信息不进记忆内容）、每轮最多 3 条。
 */
export function memoryExtractOk(output, { vars }) {
  const o = parse(output)
  const all = Array.isArray(o?.memories) ? o.memories : []
  const written = all.filter(m => !m.route)
  const forgot = Array.isArray(o?.forget) ? o.forget : []
  const contents = written.map(m => String(m.content ?? ''))
  const fail = reason => ({ pass: false, score: 0, reason })
  if (written.length > 3) return fail(`一轮写了 ${written.length} 条，超过 3 条`)
  const leaked = (vars.forbidden ?? []).filter(t => contents.some(c => c.includes(t)))
  if (leaked.length) return fail(`记忆内容里出现了不该记的信息：${leaked.join('、')}`)
  if (vars.expect_replaces) {
    const handled = forgot.includes(vars.expect_replaces) || written.some(m => [].concat(m.supersedes ?? []).includes(vars.expect_replaces))
    if (!handled) return fail(`用户更正了 ${vars.expect_replaces}，但没有取代或忘掉它`)
  }
  if (vars.expect_none) return written.length ? fail(`这一轮不该记，却记了：${contents.join(' / ')}`) : { pass: true, score: 1, reason: '克制：没有记' }
  if (vars.must_include?.length && !contents.some(c => vars.must_include.some(t => c.includes(t)))) return fail(`没有记下应该记的（${vars.must_include.join(' / ')}），实际：${contents.join(' / ') || '无'}`)
  if (vars.expect_scope && !written.some(m => (m.scope ?? 'user') === vars.expect_scope)) return fail(`应记到 ${vars.expect_scope}，实际 scope：${written.map(m => m.scope ?? 'user').join('、') || '无'}`)
  if (vars.forbid_scope && written.some(m => (m.scope ?? 'user') === vars.forbid_scope)) return fail(`不该记到 ${vars.forbid_scope}`)
  if (vars.expect_route && !all.some(m => m.route === vars.expect_route)) return fail(`应转到 ${vars.expect_route}，实际 route：${all.map(m => m.route ?? 'null').join('、') || '无'}`)
  return { pass: true, score: 1, reason: `记下 ${written.length} 条：${contents.join(' / ') || '无'}` }
}
