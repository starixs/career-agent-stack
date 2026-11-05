/**
 * 用量记账：所有花钱的地方（主对话每轮、后台模型调用、搜索等工具、语音转写）都只调这里。
 *
 * 每次调用落一行 billing_usage（0 积分的也落，看得见调了几次）；同一 scope 内累计精确成本，
 * 取整后比已扣的多出来的部分才落一笔 spend，幂等键 = `usage:<用量幂等键>`。
 * scope 的取法：主对话按会话 id；后台调用按「background:本地日期」，一天一个累计窗口。
 */
import { type Db, now } from '../db/db.js'
import { newId } from '../ids.js'
import { PRICING_TEMPLATE, checkinCredits, type PricingTemplate } from './catalog.js'
import { balanceOf, deductCredits, ensureAccount, grantCredits, writeTx } from './ledger.js'
import { asrCredits, canonicalizeModelName, ceilCredits, isFallbackPriced, rawLlmCredits, toolCogsMicroUsd, toolCredits, type LlmUsageTokens } from './pricing.js'

export type UsageOrigin = 'chat' | 'background' | 'tool'

export interface UsageRow {
  id: string
  idempotency_key: string
  scope: string
  origin: UsageOrigin
  kind: 'llm' | 'tool' | 'asr'
  name: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  quantity: number
  raw_credits: number
  credits_charged: number
  cogs_micro_usd: number
  priced: number
  created_at: string
}

export interface MeterResult {
  /** false = 这条用量记过了（重放），什么都没变 */
  recorded: boolean
  creditsCharged: number
  balance: number
  /** 走了兜底价的模型 / 没登记价目的工具：要打告警，别让「白送」没人发现 */
  unpriced: boolean
}

type UsageDraft = Omit<UsageRow, 'id' | 'credits_charged' | 'created_at'>

function scopeTotals(db: Db, scope: string): { raw: number; charged: number } {
  const r = db.get<{ raw: number | null; charged: number | null }>('SELECT SUM(raw_credits) AS raw, SUM(credits_charged) AS charged FROM billing_usage WHERE scope=?', [scope])
  return { raw: r?.raw ?? 0, charged: r?.charged ?? 0 }
}

/** 落一行用量并按 scope 累计取整扣费；同一幂等键第二次进来直接返回 recorded=false。 */
function meter(db: Db, draft: UsageDraft, description: string): MeterResult {
  return writeTx(db, () => {
    const account = ensureAccount(db)
    const unpriced = draft.priced === 0
    if (db.get('SELECT 1 FROM billing_usage WHERE idempotency_key=?', [draft.idempotency_key])) {
      return { recorded: false, creditsCharged: 0, balance: balanceOf(account), unpriced }
    }
    const id = newId('use')
    db.insert('billing_usage', { ...draft, id, credits_charged: 0, created_at: now() })
    const totals = scopeTotals(db, draft.scope)
    const delta = Math.max(ceilCredits(totals.raw) - totals.charged, 0)
    if (delta === 0) return { recorded: true, creditsCharged: 0, balance: balanceOf(account), unpriced }
    db.run('UPDATE billing_usage SET credits_charged=? WHERE id=?', [delta, id])
    const res = deductCredits(db, delta, {
      sourceType: `${draft.kind}_usage`, sourceId: draft.scope, idempotencyKey: `usage:${draft.idempotency_key}`, description,
      extra: { usage_id: id, name: draft.name, origin: draft.origin, raw_credits: draft.raw_credits },
    })
    return { recorded: true, creditsCharged: delta, balance: balanceOf(res.account), unpriced }
  })
}

export interface LlmUsageInput extends LlmUsageTokens {
  /** 幂等键：主对话用 `chat:<会话>:<轮次>`，后台调用用一次性 id */
  idempotencyKey: string
  scope: string
  origin: UsageOrigin
  model: string
}

export function recordLlmUsage(db: Db, input: LlmUsageInput, template: PricingTemplate = PRICING_TEMPLATE): MeterResult {
  const model = canonicalizeModelName(input.model) || 'unknown'
  const nonNeg = (n: number | undefined) => Math.max(Math.round(n ?? 0), 0)
  return meter(db, {
    idempotency_key: input.idempotencyKey, scope: input.scope, origin: input.origin, kind: 'llm', name: model,
    input_tokens: nonNeg(input.inputTokens), output_tokens: nonNeg(input.outputTokens),
    cache_read_tokens: nonNeg(input.cacheReadTokens), cache_creation_tokens: nonNeg(input.cacheCreationTokens), quantity: 1,
    raw_credits: rawLlmCredits(input.model, input, template.llmMarginMultiplier), cogs_micro_usd: 0,
    priced: isFallbackPriced(input.model) ? 0 : 1,
  }, input.origin === 'chat' ? '对话用量' : '后台任务用量')
}

export interface ToolUsageInput { idempotencyKey: string; scope: string; tool: string; count?: number }

/** 工具按次：价目由 pricing.ts 说了算；没登记的工具记 0 积分但标 priced=0。 */
export function recordToolUsage(db: Db, input: ToolUsageInput): MeterResult {
  const count = Math.max(Math.round(input.count ?? 1), 1)
  const unit = toolCredits(input.tool)
  return meter(db, {
    idempotency_key: input.idempotencyKey, scope: input.scope, origin: 'tool', kind: 'tool', name: input.tool,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, quantity: count,
    raw_credits: (unit ?? 0) * count, cogs_micro_usd: toolCogsMicroUsd(input.tool) * count, priced: unit === undefined ? 0 : 1,
  }, `工具调用：${input.tool}`)
}

export interface AsrUsageInput { idempotencyKey: string; scope: string; durationMs: number | null }

export function recordAsrUsage(db: Db, input: AsrUsageInput): MeterResult {
  return meter(db, {
    idempotency_key: input.idempotencyKey, scope: input.scope, origin: 'background', kind: 'asr', name: 'asr',
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, quantity: Math.max(Math.round(input.durationMs ?? 0), 0),
    raw_credits: asrCredits(input.durationMs), cogs_micro_usd: 0, priced: 1,
  }, '语音转写')
}

/** 后台调用的 scope：按本地日期一天一个累计窗口。 */
export function backgroundScope(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `background:${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** 每日签到：一天一次（幂等键 checkin:本地日期），额度按会员档。 */
export function checkin(db: Db, at: Date = new Date(), template: PricingTemplate = PRICING_TEMPLATE): { granted: boolean; credits: number; balance: number } {
  const account = ensureAccount(db, template)
  const credits = checkinCredits(account.tier, template)
  if (credits <= 0) return { granted: false, credits: 0, balance: balanceOf(account) }
  const day = backgroundScope(at).slice('background:'.length)
  const res = grantCredits(db, credits, { sourceType: 'checkin', idempotencyKey: `checkin:${day}`, description: `${day} 签到` })
  return { granted: res.created, credits: res.created ? credits : 0, balance: balanceOf(res.account) }
}
