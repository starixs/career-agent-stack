/**
 * 统一的模型调用接口。所有技能与引擎只依赖这个接口，不直接依赖任何 SDK；
 * 真实实现在 @career/agent（Anthropic SDK / OpenAI 兼容），测试用 FakeLLM。
 */
export type LlmRole = 'user' | 'assistant'
export interface LlmMessage { role: LlmRole; content: string }
export interface LlmRequest {
  system?: string
  messages: LlmMessage[]
  /** 要求模型只输出 JSON（实现负责抽取与解析）。 */
  json?: boolean
  maxTokens?: number
  temperature?: number
}
export interface LlmUsage { input_tokens: number; output_tokens: number }
export interface LlmResponse { text: string; usage: LlmUsage }

export interface LLM {
  complete(req: LlmRequest): Promise<LlmResponse>
}

/** 从模型回复里抽 JSON（容忍 ```json 代码块与前后噪声）。 */
export function extractJson<T = unknown>(text: string): T {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence ? fence[1] : text).trim()
  const start = body.search(/[\[{]/)
  if (start < 0) throw new Error('模型回复中没有 JSON')
  const candidate = body.slice(start)
  let depth = 0, inStr = false, esc = false
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return JSON.parse(candidate.slice(0, i + 1)) as T }
  }
  return JSON.parse(candidate) as T
}

/** 测试用：按顺序或按匹配规则返回预设回复。 */
export class FakeLLM implements LLM {
  calls: LlmRequest[] = []
  private queue: Array<string | ((req: LlmRequest) => string)> = []
  constructor(responses: Array<string | ((req: LlmRequest) => string)> = []) { this.queue = [...responses] }
  push(r: string | ((req: LlmRequest) => string)): this { this.queue.push(r); return this }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req)
    const next = this.queue.shift()
    if (next === undefined) throw new Error('FakeLLM: 没有预设回复了')
    const text = typeof next === 'function' ? next(req) : next
    return { text, usage: { input_tokens: 0, output_tokens: 0 } }
  }
}
