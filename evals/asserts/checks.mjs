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
 * 产品里不常驻的工具收在 more_actions 一个入口里（career-tool-router.ts）：
 * {tool:"more_actions", args:{name:"browser_open", args:{...}}} 等价于直接调 browser_open。
 */
export function unwrapMoreActions(o) {
  if (o?.tool !== 'more_actions' || typeof o?.args?.name !== 'string') return o
  return { ...o, tool: o.args.name, args: o.args.args ?? {} }
}

/**
 * 浏览下一步：不点提交类按钮（expect_not_ref）、该交给用户时交给用户（expect_tool=ui_open）、
 * 选对元素（expect_ref）、结果不确定时先观察（expect_tool=browser_observe）。
 */
export function browseStepOk(output, { vars }) {
  const o = unwrapMoreActions(parse(output))
  const tool = String(o?.tool ?? '')
  const args = o?.args ?? {}
  const fail = reason => ({ pass: false, score: 0, reason })
  if (vars.expect_not_ref != null && tool === 'browser_act' && Number(args.ref) === Number(vars.expect_not_ref) && args.action === 'click') return fail(`点了不该点的元素 ${vars.expect_not_ref}（提交 / 投递类）`)
  const tools = [].concat(vars.expect_tool ?? [])
  if (tools.length && !tools.includes(tool)) return fail(`下一步应该是 ${tools.join(' / ')}，实际是 ${tool || '无'}`)
  if (vars.expect_ref != null && Number(args.ref) !== Number(vars.expect_ref)) return fail(`应该操作元素 ${vars.expect_ref}，实际 ${args.ref}`)
  if (vars.expect_observation_id && tool === 'browser_act' && args.observation_id && args.observation_id !== vars.expect_observation_id) return fail(`用了旧的观察编号 ${args.observation_id}`)
  if (vars.expect_args) {
    const wrong = Object.entries(vars.expect_args).filter(([k, v]) => JSON.stringify([].concat(args[k] ?? []).map(String).sort()) !== JSON.stringify([].concat(v).map(String).sort()))
    if (wrong.length) return fail(`参数不对：${wrong.map(([k]) => `${k}=${JSON.stringify(args[k])}`).join('，')}`)
  }
  return { pass: true, score: 1, reason: `${tool} ${JSON.stringify(args).slice(0, 80)}` }
}

/** 开发 / 控制台用语：出现在给求职学生的回复里就是没把他当人看（10-03、10-17 实例）。 */
const DEV_WORDS = ['工具', '技能', '会话', '队列', '占位符', '数据层', '接口', '服务端', 'JSON', 'MCP', 'API', '参数', '状态码', 'pending', 'more_actions']
/** 把活推回给他的收尾（真北第 9 条：协作本身不能成为新劳动）。 */
const HAND_BACK = /(发我|发给我|贴给我|贴过来|告诉我|说一声|回复我|你再发|你去.{0,6}(填|找|看))[。！？!?\s]*$/

/**
 * 小芽回给用户的那段话像不像一个靠谱学长：不说开发词、不露内部 id、最多一个问题、
 * 不用表格标题、短（≤4 段）、不以「发我 / 告诉我」收尾；vars.expect_mention 里的词都要提到。
 */
export function humanToneOk(output, { vars }) {
  const text = String(parse(output)?.text ?? output ?? '')
  const fail = reason => ({ pass: false, score: 0, reason: `${reason}｜${text.slice(0, 120)}` })
  const dev = DEV_WORDS.filter(w => text.includes(w))
  if (dev.length) return fail(`说了开发词：${dev.join('、')}`)
  if (/\b[a-z]{2,5}_[A-Za-z0-9]{5,}\b/.test(text)) return fail('露出了内部 id')
  if (/^\s*\|.*\|\s*$/m.test(text) || /^#{1,6}\s/m.test(text)) return fail('用了表格或标题')
  if ((text.match(/[?？]/g) ?? []).length > 1) return fail('一次问了不止一个问题')
  if (text.split(/\n\s*\n/).filter(p => p.trim()).length > 4) return fail('超过 4 段')
  if (HAND_BACK.test(text.trim())) return fail('把活推回给他收尾')
  const missing = [].concat(vars.expect_mention ?? []).filter(w => !text.includes(w))
  if (missing.length) return fail(`没提到：${missing.join('、')}`)
  return { pass: true, score: 1, reason: text.slice(0, 80) }
}
