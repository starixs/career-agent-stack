/**
 * promptfoo 自定义 provider：直接调用产品里的真实流水线（提示词 + 后处理），而不是另写一份提示词。
 * 只在开发 / CI 用，不进产品。模型走 OpenAI 兼容接口（缺省 DeepSeek）：
 *   CAREER_LLM_API_KEY（必需）、CAREER_EVAL_BASE_URL（缺省 https://api.deepseek.com）、CAREER_EVAL_MODEL（缺省 deepseek-flash，与产品一致）
 * 先 `pnpm -r build`（用各包的 dist）。
 *
 * vars.task：
 *   tailor            → @career/resume 的 tailorResume（含编造检测），输出 { changes, truthfulnessFlags }
 *   job_evaluate      → skills/job-evaluate，输出模型 JSON
 *   interview_questions → skills/interview-questions，输出模型 JSON
 *   exam_grade        → 笔试批改（与 exam_practice 工具同一套要求），输出 { review:[{index, verdict, comment}] }
 *   browse_next_step  → assistant-core + 浏览工具约定：给页面观察（与 career-tools formatBrowse 同格式）和目标，输出下一步工具调用 JSON
 *   chat_first_step   → assistant-core + 系统提示 <career-tools> 段 + 产品里这些工具的原文描述：给用户一句话，输出第一步工具调用 JSON
 */
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = await import(join(root, 'packages/core/dist/index.js'))
const resume = await import(join(root, 'packages/resume/dist/index.js'))

export function evalLlm(env = process.env, fetchImpl = fetch) {
  const key = env.CAREER_LLM_API_KEY
  if (!key) throw new Error('需要 CAREER_LLM_API_KEY 才能跑评测')
  const base = (env.CAREER_EVAL_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = env.CAREER_EVAL_MODEL ?? 'deepseek-flash' // 与产品默认模型一致（shared/career-build-constants.ts）
  return {
    async complete({ system, messages, json, temperature }) {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: temperature ?? 0.2, ...(json ? { response_format: { type: 'json_object' } } : {}), messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] }),
      })
      if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const data = await res.json()
      return { text: data.choices?.[0]?.message?.content ?? '' }
    },
  }
}

const skill = name => core.skillPrompt(core.loadSkill(join(root, 'skills'), name))

export async function runTask(vars, llm) {
  switch (vars.task) {
    case 'tailor': {
      const r = await resume.tailorResume(llm, { master: vars.master, jd: vars.jd, claims: vars.claims, strength: vars.strength ?? 'full' })
      return { changes: r.patch.map(p => ({ path: p.path, value: p.value })), truthfulnessFlags: r.truthfulnessFlags.map(f => ({ kind: f.kind, token: f.token })), rejected: r.rejected.length }
    }
    case 'job_evaluate':
    case 'interview_questions': {
      const name = vars.task === 'job_evaluate' ? 'job-evaluate' : 'interview-questions'
      const res = await llm.complete({ system: skill(name), messages: [{ role: 'user', content: vars.input }], json: true, temperature: 0.2 })
      return core.extractJson(res.text)
    }
    case 'exam_grade': {
      const system = '你是笔试批改助手。逐题对照参考答案批改用户作答，verdict 只能是 对 / 错 / 部分对；没有参考答案的题按题意判断并在 comment 写依据。不要改变题目。输出 JSON：{"review":[{"index":0,"verdict":"对","comment":""}]}'
      const res = await llm.complete({ system, messages: [{ role: 'user', content: JSON.stringify({ questions: vars.questions, answers: vars.answers }) }], json: true, temperature: 0 })
      return core.extractJson(res.text)
    }
    case 'browse_next_step': {
      const system = `${skill('assistant-core')}\n\n# 可用的浏览工具\nbrowser_open{url} / browser_observe{} / browser_act{action, observation_id, ref, text, submit, key, direction, tab} / browser_read{offset} / browser_capture_job{} / apply_prepare{job_id} / browser_solve_captcha{}（自己过验证码）/ browser_wait_user{what, waiting_for}（请用户帮一下，做完接着办）/ ui_open{target:"live"}。\n只输出下一步的一个工具调用：{"tool":"...","args":{...},"reason":"一句话"}`
      const user = `目标：${vars.goal}\n\n最近一次结果：\n${vars.observation}`
      const res = await llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0 })
      return core.extractJson(res.text)
    }
    case 'chat_first_step': {
      const system = `${skill('assistant-core')}\n\n${careerToolsBlock()}\n\n# 可用工具（产品原文描述）\n${toolCatalog(FIRST_STEP_TOOLS)}\n\n只输出第一步的一个工具调用：{"tool":"...","args":{...},"reason":"一句话"}；不需要工具就输出 {"tool":"none","args":{},"reason":"..."}`
      const res = await llm.complete({ system, messages: [{ role: 'user', content: vars.message }], json: true, temperature: 0 })
      return core.extractJson(res.text)
    }
    default: throw new Error(`未知 task：${vars.task}`)
  }
}

// chat_first_step 用产品源码里的原文（系统提示段 + 工具描述），不另抄一份，免得和产品漂移
export const FIRST_STEP_TOOLS = ['web_search', 'web_fetch', 'company_research', 'job_import', 'jd_parse', 'inbox_capture', 'browser_open', 'browser_observe', 'browser_act', 'browser_read', 'browser_capture_job', 'ui_open']
const shellSrc = rel => readFileSync(join(root, 'shell/src/server', rel), 'utf8')
export function careerToolsBlock() {
  const m = /<career-tools>[\s\S]*?<\/career-tools>/.exec(shellSrc('system-prompt.ts'))
  if (!m) throw new Error('system-prompt.ts 里找不到 <career-tools> 段')
  return m[0]
}
export function toolCatalog(names) {
  const src = shellSrc('tools/career-tools.ts')
  return names.map(name => {
    const m = new RegExp(`tool\\('${name}', '([^']+)'`).exec(src)
    if (!m) throw new Error(`career-tools.ts 里找不到工具 ${name}`)
    return `- ${name}：${m[1]}`
  }).join('\n')
}

export default class CareerProvider {
  id() { return 'career-pipelines' }
  async callApi(_prompt, context) {
    try {
      const output = await runTask(context.vars, evalLlm())
      return { output: JSON.stringify(output) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
}
