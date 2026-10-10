/**
 * promptfoo 自定义 provider：直接调用产品里的真实流水线（提示词 + 后处理），而不是另写一份提示词。
 * 只在开发 / CI 用，不进产品。模型走 OpenAI 兼容接口（缺省 DeepSeek）：
 *   CAREER_LLM_API_KEY（必需）、CAREER_EVAL_BASE_URL（缺省 https://api.deepseek.com）、CAREER_EVAL_MODEL（缺省 deepseek-chat）
 * 先 `pnpm -r build`（用各包的 dist）。
 *
 * vars.task：
 *   tailor            → @career/resume 的 tailorResume（含编造检测），输出 { changes, truthfulnessFlags }
 *   job_evaluate      → skills/job-evaluate，输出模型 JSON
 *   interview_questions → skills/interview-questions，输出模型 JSON
 *   exam_grade        → 笔试批改（与 exam_practice 工具同一套要求），输出 { review:[{index, verdict, comment}] }
 *   memory_extract    → skills/memory-extract，输入格式与产品 career/memory-service.ts 的 extractMemories 一致，输出模型 JSON
 */
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const core = await import(join(root, 'packages/core/dist/index.js'))
const resume = await import(join(root, 'packages/resume/dist/index.js'))

export function evalLlm(env = process.env, fetchImpl = fetch) {
  const key = env.CAREER_LLM_API_KEY
  if (!key) throw new Error('需要 CAREER_LLM_API_KEY 才能跑评测')
  const base = (env.CAREER_EVAL_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = env.CAREER_EVAL_MODEL ?? 'deepseek-chat'
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
    case 'memory_extract': {
      const existing = (vars.existing ?? []).map(m => `${m.id} [${m.kind} · ${m.scope ?? 'user'}] ${m.content}`).join('\n') || '（无）'
      const user = `本轮用户原话：\n${vars.user}\n\n本轮助理最终回答：\n${vars.assistant ?? ''}\n\n已有的相关记忆：\n${existing}`
      const res = await llm.complete({ system: skill('memory-extract'), messages: [{ role: 'user', content: user }], json: true, temperature: 0.1 })
      return core.extractJson(res.text)
    }
    default: throw new Error(`未知 task：${vars.task}`)
  }
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
