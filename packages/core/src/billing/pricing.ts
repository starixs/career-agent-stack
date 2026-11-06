/**
 * 价目表与积分计算（纯函数，无 IO）。
 *
 * 口径照 Star AI `apps/backend/app/core/pricing.py`（origin/main，2026-10-08）搬过来，数值逐项一致：
 *  - 1 元 = 5 积分，即 1 积分 = ¥0.2；模型价目 = 厂商公开人民币单价 × 5，单位「积分 / 百万 token」。
 *  - 最终扣费 = 成本价 × 毛利倍数（catalog.ts 的 llmMarginMultiplier），会话内累计后再向上取整。
 *  - 工具按次计价，是查表整数，不过毛利倍数。
 *
 * 和 Star AI 唯一的口径差别：这里的 inputTokens **不含**缓存命中（DeepSeek 接口回的用量就是这样分开的，
 * 2026-11-05 用本机真实会话核对过：一轮 10.5 万输入、180 万缓存命中），Star AI 的 input 含缓存再减。
 * 换算只在 rawLlmCredits 一处做，调用方原样传 SDK 给的数。
 */

/** 可 grep 的价目版本锚点：价目任何一项变了就 +1，云端价目表上线后两边按它对表。 */
export const PRICING_TABLE_ANCHOR = '[pricing] version=2 aligned=star_ai/apps/backend/app/core/pricing.py@2026-10-08'

/** 一百万：价目单位是「每百万 token」。 */
const TOKENS_PER_PRICE_UNIT = 1_000_000
/** 取整前先抹掉浮点累加误差，避免 0.1×10 在整数边界多收 1 积分（Star AI ceil_credits 同值）。 */
const CREDIT_ROUND_DIGITS = 9

export interface LlmPrice {
  /** 未命中缓存的输入 */
  input: number
  output: number
  /** 命中已有缓存的输入 */
  cache: number
}

/** 规范模型 id → 价目。只收境内模型（合规）。 */
export const MODEL_PRICING: Readonly<Record<string, LlmPrice>> = {
  // 内置模型。¥1 入 / ¥2 出 / ¥0.02 缓存命中 → ×5
  'deepseek-v4-flash': { input: 5.0, output: 10.0, cache: 0.1 },
  // ¥3 入 / ¥6 出 / ¥0.025 缓存命中 → ×5。现在没有入口，先登记，开高档模型时不用再改表
  'deepseek-v4-pro': { input: 15.0, output: 30.0, cache: 0.125 },
}

/** 没登记的模型走这一档（约 ¥1 / ¥4 每百万），并打告警：宁可偏保守，不静默免费。 */
export const FALLBACK_LLM_PRICING: LlmPrice = { input: 5.0, output: 20.0, cache: 1.25 }

/** 别名 → 规范 id。key 全小写，匹配前先去掉 `provider:` 前缀。 */
const MODEL_ALIASES: Readonly<Record<string, string>> = {
  // 内置 provider 配的就是这个名字，DeepSeek 接口回显的也是它
  'deepseek-flash': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'deepseek/deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-pro': 'deepseek-v4-pro',
  'deepseek/deepseek-v4-pro': 'deepseek-v4-pro',
}

const PROVIDER_PREFIXES = ['deepseek:', 'openrouter:', 'siliconflow:', 'custom:'] as const

/** 模型名末尾的日期戳（`-20260101` 或 `-2026-01-23`）：快照轮换后不剥掉会静默跌进兜底价。 */
const DATE_SUFFIX_RE = /(?:-\d{4}-\d{2}-\d{2}|-\d{6,8})$/

function stripProviderPrefix(name: string): string {
  const lower = name.toLowerCase()
  for (const prefix of PROVIDER_PREFIXES) if (lower.startsWith(prefix)) return name.slice(prefix.length)
  return name
}

/** 查表一律走 hasOwn：模型名和工具名都不可信，`constructor` 这类键会取到原型链上的东西。 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** 任意写法的模型名 → 规范 id；没命中时返回去前缀后的小写名，方便日志里追。 */
export function canonicalizeModelName(modelName: string): string {
  const key = stripProviderPrefix(modelName.trim()).toLowerCase()
  if (!key) return ''
  const direct = own(MODEL_ALIASES, key) ?? (own(MODEL_PRICING, key) ? key : undefined)
  if (direct) return direct
  const stripped = key.replace(DATE_SUFFIX_RE, '')
  if (stripped === key) return key
  return own(MODEL_ALIASES, stripped) ?? (own(MODEL_PRICING, stripped) ? stripped : key)
}

/** 这个模型名计费时会不会跌进兜底价（给告警和用量页用，不改计价）。 */
export function isFallbackPriced(modelName: string): boolean {
  return own(MODEL_PRICING, canonicalizeModelName(modelName)) === undefined
}

export function resolveModelPrice(modelName: string): LlmPrice {
  return own(MODEL_PRICING, canonicalizeModelName(modelName)) ?? FALLBACK_LLM_PRICING
}

/** 一次 DeepSeek 调用的用量：inputTokens 是未命中缓存的输入，命中缓存的单列在 cacheReadTokens。 */
export interface LlmUsageTokens {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  /** 写缓存的 token：DeepSeek 不单独收费，按普通输入计 */
  cacheCreationTokens?: number
}

const nonNegative = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/**
 * 一次模型调用的**精确**积分成本（不取整）。
 * 单次调用常只有零点几积分，逐次取整会把实扣放大数倍（Star AI 2026-10-05 核对：一周 997 对 201），
 * 所以累计处才取整，见 ledger.ts 的 chargeWithCarry。
 */
export function rawLlmCredits(modelName: string, usage: LlmUsageTokens, marginMultiplier = 1): number {
  const price = resolveModelPrice(modelName)
  const uncached = nonNegative(usage.inputTokens) + nonNegative(usage.cacheCreationTokens)
  const raw = (uncached * price.input + nonNegative(usage.cacheReadTokens) * price.cache + nonNegative(usage.outputTokens) * price.output) / TOKENS_PER_PRICE_UNIT
  // 非正的倍数按 1 算：0 倍会把扣费抹平
  return raw * (marginMultiplier > 0 ? marginMultiplier : 1)
}

/** 精确成本 → 实扣整数积分：向上取整，最少 0。 */
export function ceilCredits(raw: number): number {
  return Math.max(Math.ceil(Number(raw.toFixed(CREDIT_ROUND_DIGITS))), 0)
}

/** 工具的两个维度分开记：向用户收多少（定价），我们自己花多少（成本）。 */
export interface ToolPrice {
  /** 每次向用户收的积分 */
  credits: number
  /** 我方真实采购成本，微美元 / 次（1e-6 USD）；没有外部成本记 0 */
  cogsMicroUsd: number
  /** 给人看的名字（用量页、计费清单） */
  label: string
  note: string
}

/** 人民币单价 → 微美元（按 1 美元 = 7 元）。 */
const rmbToMicroUsd = (rmb: number): number => Math.round((rmb / 7) * 1_000_000)

/**
 * 工具按次价目。搜索真实成本都不到 ¥0.2 / 次，按最小计费单位收 1 积分。
 * 其余求职工具背后只有模型调用，成本已经在 token 里，**显式写 0**：
 * 表示「看过、定的是 0」，和「没人想过这件事」分开。新加会花钱的外部服务时在这里加一行。
 */
export const TOOL_PRICING: Readonly<Record<string, ToolPrice>> = {
  // 内置模型 Key 走的 DeepSeek 搜索（没单独配搜索 Key 时的默认）。官方价：每 1,000 次成功请求 ¥5
  // （api-docs.deepseek.com 定价页，2026-11-06 核对），即 ¥0.005 / 次；失败的搜索我们不计量，口径一致。
  'search:deepseek': { credits: 1, cogsMicroUsd: rmbToMicroUsd(0.005), label: '联网搜索（DeepSeek）', note: '成本 ¥0.005 / 次' },
  'search:bocha': { credits: 1, cogsMicroUsd: rmbToMicroUsd(0.032), label: '联网搜索（博查）', note: '成本 ¥0.032 / 次' },
  'search:tavily': { credits: 1, cogsMicroUsd: 7500, label: '联网搜索（Tavily）', note: '成本 $0.0075 / 次' },
  'search:serper': { credits: 1, cogsMicroUsd: 5000, label: '联网搜索（Serper）', note: '成本 $0.005 / 次' },
  web_fetch: { credits: 0, cogsMicroUsd: 0, label: '读网页', note: '本机抓取，没有外部成本' },
  attachment_read: { credits: 0, cogsMicroUsd: 0, label: '读附件', note: '本机转文字，不调模型' },
  resume_export: { credits: 0, cogsMicroUsd: 0, label: '导出简历', note: '本机排版导出' },
  send_mail: { credits: 0, cogsMicroUsd: 0, label: '发邮件', note: '走用户自己的邮箱' },
  browser_solve_captcha: { credits: 0, cogsMicroUsd: 0, label: '过验证码', note: '视觉模型的 token 已按量计' },
}

/** 工具单次积分；没登记的工具返回 undefined（调用方要把它当「未定价」上报，不能悄悄当 0）。 */
export function toolCredits(toolName: string): number | undefined {
  return own(TOOL_PRICING, toolName)?.credits
}

export function toolCogsMicroUsd(toolName: string): number {
  return own(TOOL_PRICING, toolName)?.cogsMicroUsd ?? 0
}

/** 语音转写价目（面试录音复盘；现在还没接识别，先把口径定下）。 */
export const ASR_PRICING = { freeSeconds: 180, creditsPerMinute: 0.2 } as const

const MS_PER_MINUTE = 60_000

/**
 * 语音转写积分：时长未知不扣；免费时长以内不扣；超过后按**整段**时长计、至少 1 积分。
 */
export function asrCredits(durationMs: number | null | undefined, pricing: { freeSeconds: number; creditsPerMinute: number } = ASR_PRICING): number {
  if (durationMs === null || durationMs === undefined) return 0
  if (durationMs <= pricing.freeSeconds * 1000) return 0
  return Math.max(Math.ceil((durationMs / MS_PER_MINUTE) * pricing.creditsPerMinute), 1)
}
