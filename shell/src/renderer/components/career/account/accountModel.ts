/**
 * 「账号与用量」页的纯逻辑：接口返回的类型、把用量分组归成用户看得懂的几类、流水的叫法。
 * 数据来自 /api/career/billing/*（server/routes/career-billing.ts），计价口径在 @career/core billing/。
 */

export interface UsageBucket {
  origin: 'chat' | 'background' | 'tool'
  kind: 'llm' | 'tool' | 'asr'
  name: string
  calls: number
  credits: number
  unpricedCalls: number
}

export interface CreditTxn {
  id: string
  type: 'earn' | 'spend' | 'refund' | 'admin_adjust'
  amount: number
  balance_after: number
  source_type: string | null
  description: string | null
  created_at: string
}

export interface BillingSummary {
  account: { tier: string; credits: number; subscription_credits: number; subscription_expires_at: string | null }
  balance: number
  windowDays: number
  spentInWindow: number
  buckets: UsageBucket[]
  daily: Array<{ day: string; credits: number; calls: number }>
  recent: CreditTxn[]
}

export interface PriceList {
  creditUnitPriceCents: number
  models: Array<{ model: string; label: string; inputPerMillion: number; outputPerMillion: number; cachePerMillion: number }>
  tools: Array<{ tool: string; label: string; credits: number }>
  asr: { freeSeconds: number; creditsPerMinute: number }
  signupGrantCredits: number
  checkinDailyCredits: Record<string, number>
  plans: Array<{ id: string; name: string; billingPeriod: 'month' | 'quarter'; priceCents: number; creditsGranted: number; badge: string | null }>
  topupPackages: Array<{ id: string; credits: number; priceCents: number }>
}

export type UsageGroupId = 'chat' | 'background' | 'search' | 'other'

export interface UsageGroup { id: UsageGroupId; label: string; credits: number; calls: number }

const GROUP_LABELS: Record<UsageGroupId, string> = {
  chat: '和小芽对话',
  background: '后台替你办事',
  search: '联网搜索',
  other: '其他',
}

function groupOf(b: UsageBucket): UsageGroupId {
  if (b.kind === 'llm') return b.origin === 'chat' ? 'chat' : 'background'
  if (b.name.startsWith('search:')) return 'search'
  return 'other'
}

/** 用量按用户看得懂的四类归并，花得多的在前；没有调用的类不出现。 */
export function groupUsage(buckets: readonly UsageBucket[]): UsageGroup[] {
  const map = new Map<UsageGroupId, UsageGroup>()
  for (const b of buckets) {
    const id = groupOf(b)
    const g = map.get(id) ?? { id, label: GROUP_LABELS[id], credits: 0, calls: 0 }
    g.credits += b.credits
    g.calls += b.calls
    map.set(id, g)
  }
  return [...map.values()].sort((a, b) => b.credits - a.credits || b.calls - a.calls)
}

const SOURCE_LABELS: Record<string, string> = {
  signup: '开户赠送',
  checkin: '每日签到',
  topup: '充值',
  subscription: '套餐积分',
  llm_usage: '模型用量',
  tool_usage: '工具用量',
  asr_usage: '语音转写',
  admin: '人工调整',
}

/** 流水一行的叫法：优先用记账时写的描述，没有就按来源。 */
export function txnLabel(t: CreditTxn): string {
  return t.description?.trim() || (t.source_type ? SOURCE_LABELS[t.source_type] ?? t.source_type : '积分变动')
}

/** 金额（分）→「¥39」/「¥0.2」。 */
export function yuan(cents: number): string {
  const v = cents / 100
  return `¥${Number.isInteger(v) ? v : v.toFixed(2).replace(/0$/, '')}`
}

/** 补齐最近 N 天（没有用量的天记 0），柱状图按天对齐。day 是 UTC 日期 YYYY-MM-DD。 */
export function fillDays(daily: BillingSummary['daily'], days: number, now: Date = new Date()): Array<{ day: string; credits: number }> {
  const byDay = new Map(daily.map(d => [d.day, d.credits]))
  const out: Array<{ day: string; credits: number }> = []
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10)
    out.push({ day, credits: byDay.get(day) ?? 0 })
  }
  return out
}
