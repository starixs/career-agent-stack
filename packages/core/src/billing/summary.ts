/**
 * 用量汇总：给「设置 → 账号与用量」页和以后的云端对账读。只读，不改账。
 */
import type { Db } from '../db/db.js'
import { balanceOf, ensureAccount, listTransactions, type CreditAccount, type CreditTransaction } from './ledger.js'
import type { UsageOrigin } from './meter.js'
import { countBusinessEvents, type EventCount } from './events.js'

/** 用量页默认看最近 30 天。 */
export const USAGE_WINDOW_DAYS = 30
const MS_PER_DAY = 86_400_000

export interface UsageBucket {
  origin: UsageOrigin
  kind: 'llm' | 'tool' | 'asr'
  name: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  credits: number
  cogsMicroUsd: number
  /** 这一组里走了兜底价 / 没定价的调用次数 */
  unpricedCalls: number
}

export interface DailyUsage { day: string; credits: number; calls: number }

export interface BillingSummary {
  account: CreditAccount
  balance: number
  windowDays: number
  since: string
  spentInWindow: number
  buckets: UsageBucket[]
  daily: DailyUsage[]
  recent: CreditTransaction[]
  /** 场景卖点：这段时间替用户做成了什么（投出几份、定制几份简历……） */
  events: EventCount[]
}

interface BucketRow {
  origin: UsageOrigin; kind: UsageBucket['kind']; name: string; calls: number
  input_tokens: number; output_tokens: number; cache_read_tokens: number; credits: number; cogs: number; unpriced: number
}

function buckets(db: Db, since: string): UsageBucket[] {
  const rows = db.all<BucketRow>(`SELECT origin, kind, name, COUNT(*) AS calls,
      SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(credits_charged) AS credits, SUM(cogs_micro_usd) AS cogs, SUM(CASE WHEN priced=0 THEN 1 ELSE 0 END) AS unpriced
    FROM billing_usage WHERE created_at >= ? GROUP BY origin, kind, name ORDER BY credits DESC, calls DESC`, [since])
  return rows.map(r => ({
    origin: r.origin, kind: r.kind, name: r.name, calls: r.calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens, credits: r.credits, cogsMicroUsd: r.cogs, unpricedCalls: r.unpriced,
  }))
}

/** 按 UTC 日期分天（created_at 存的是 UTC ISO）；界面按本地时间再标，误差最多跨一天的几小时。 */
function daily(db: Db, since: string): DailyUsage[] {
  return db.all<DailyUsage>(`SELECT substr(created_at, 1, 10) AS day, SUM(credits_charged) AS credits, COUNT(*) AS calls
    FROM billing_usage WHERE created_at >= ? GROUP BY day ORDER BY day`, [since])
}

export function billingSummary(db: Db, opts: { now?: Date; windowDays?: number; recentLimit?: number } = {}): BillingSummary {
  const account = ensureAccount(db)
  const windowDays = opts.windowDays ?? USAGE_WINDOW_DAYS
  const since = new Date((opts.now ?? new Date()).getTime() - windowDays * MS_PER_DAY).toISOString()
  const spent = db.get<{ s: number | null }>("SELECT -SUM(amount) AS s FROM credit_transaction WHERE account_id=? AND type='spend' AND created_at >= ?", [account.id, since])
  return {
    account, balance: balanceOf(account), windowDays, since, spentInWindow: spent?.s ?? 0,
    buckets: buckets(db, since), daily: daily(db, since), recent: listTransactions(db, { limit: opts.recentLimit ?? 20 }),
    events: countBusinessEvents(db, since),
  }
}
