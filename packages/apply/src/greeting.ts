import { extractJson, type LLM, type Repos } from '@career/core'
import { riskLockKey, dayOf, type RiskLock } from './safety.js'
import { randomBetween } from './pacing.js'

/**
 * Boss 打招呼策略：只做决策与节奏，不发送。发送动作永远是 send_greeting 进待审核队列，由用户批准。
 * 思路来自 trident-scanner：时间窗口、每日上限 30、随机间隔、风控即停。
 */
export interface GreetingPolicy {
  /** 本地小时窗口 [start, end)，如 [[9,12],[14,18]]。 */
  windows: Array<[number, number]>
  dailyCap: number
  minGapMs: number
  maxGapMs: number
}
export const DEFAULT_GREETING_POLICY: GreetingPolicy = { windows: [[9, 12], [14, 18]], dailyCap: 30, minGapMs: 60_000, maxGapMs: 180_000 }

export type GreetingBlock = 'risk_lock' | 'outside_window' | 'daily_cap' | 'gap'
export type CanSend = { ok: true; waitMs: 0; sentToday: number } | { ok: false; reason: GreetingBlock; waitMs: number; detail: string; sentToday: number }

interface DayRecord { count: number; lastSentAt?: string; nextAllowedAt?: string }

export class GreetingScheduler {
  readonly policy: GreetingPolicy
  readonly platform: string
  private clock: () => Date
  private rng: () => number
  constructor(private repos: Repos, policy: Partial<GreetingPolicy> = {}, opts: { platform?: string; clock?: () => Date; rng?: () => number } = {}) {
    this.policy = { ...DEFAULT_GREETING_POLICY, ...policy }
    this.platform = opts.platform ?? 'boss'
    this.clock = opts.clock ?? (() => new Date())
    this.rng = opts.rng ?? Math.random
  }
  private key(d = this.clock()) { return `greeting:${this.platform}:${dayOf(d)}` }
  private day(): DayRecord { return this.repos.kvGet<DayRecord>(this.key()) ?? { count: 0 } }
  sentToday(): number { return this.day().count }
  riskLock(): RiskLock | undefined {
    const l = this.repos.kvGet<RiskLock>(riskLockKey(this.platform))
    return l && new Date(l.until).getTime() > this.clock().getTime() ? l : undefined
  }
  inWindow(d = this.clock()): boolean {
    const h = d.getHours() + d.getMinutes() / 60
    return this.policy.windows.length === 0 || this.policy.windows.some(([s, e]) => h >= s && h < e)
  }
  /** 距下一个窗口开始的毫秒数（已在窗口内为 0）。 */
  msUntilNextWindow(d = this.clock()): number {
    if (this.inWindow(d)) return 0
    const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
    const starts = this.policy.windows.map(([s]) => s).sort((a, b) => a - b)
    const next = starts.find(s => s > h)
    const hours = next !== undefined ? next - h : 24 - h + (starts[0] ?? 0)
    return Math.ceil(hours * 3600_000)
  }
  nextGapMs(): number { return randomBetween(this.policy.minGapMs, this.policy.maxGapMs, this.rng) }
  canSendNow(): CanSend {
    const now = this.clock(); const rec = this.day(); const sentToday = rec.count
    const lock = this.riskLock()
    if (lock) return { ok: false, reason: 'risk_lock', waitMs: new Date(lock.until).getTime() - now.getTime(), detail: `风险锁（${lock.reason}）到 ${lock.until}`, sentToday }
    if (!this.inWindow(now)) return { ok: false, reason: 'outside_window', waitMs: this.msUntilNextWindow(now), detail: `不在发送时间窗 ${this.policy.windows.map(([s, e]) => `${s}-${e}点`).join('、')}`, sentToday }
    if (sentToday >= this.policy.dailyCap) return { ok: false, reason: 'daily_cap', waitMs: this.msUntilNextWindow(new Date(now.getTime() + 24 * 3600_000 - (now.getHours() * 3600_000 + now.getMinutes() * 60_000))), detail: `今日已发 ${sentToday}/${this.policy.dailyCap}`, sentToday }
    if (rec.nextAllowedAt) { const w = new Date(rec.nextAllowedAt).getTime() - now.getTime(); if (w > 0) return { ok: false, reason: 'gap', waitMs: w, detail: `距上一条间隔不足，还需 ${Math.ceil(w / 1000)} 秒`, sentToday } }
    return { ok: true, waitMs: 0, sentToday }
  }
  /** 发送成功后记录（由执行层在用户批准、送达校验通过后调用）。 */
  recordSent(at = this.clock()): DayRecord {
    const rec = this.repos.kvGet<DayRecord>(this.key(at)) ?? { count: 0 }
    const next: DayRecord = { count: rec.count + 1, lastSentAt: at.toISOString(), nextAllowedAt: new Date(at.getTime() + this.nextGapMs()).toISOString() }
    this.repos.kvSet(this.key(at), next)
    return next
  }
  lockForRisk(minutes: number, reason: RiskLock['reason'] = 'manual', detail?: string): RiskLock {
    const now = this.clock()
    const lock: RiskLock = { until: new Date(now.getTime() + Math.max(1, minutes) * 60_000).toISOString(), reason, detail, at: now.toISOString() }
    this.repos.kvSet(riskLockKey(this.platform), lock)
    return lock
  }
}

// ---------------------------------------------------------------------------
// 招呼语生成：≤ 120 字，最重要的信息放最前面，不编造；附一次自检。
// ---------------------------------------------------------------------------
export interface GreetingInput {
  job: { title: string; company?: string; salary?: string; jd?: string; requirements?: string[] }
  resumeSummary: string
  preference?: string
  maxChars?: number
  /** 是否再调一次模型做评审（默认 true）。 */
  review?: boolean
}
export interface GreetingSelfReview { chars: number; withinLimit: boolean; issues: string[]; score?: number; critique?: string; keyInfoFirst?: boolean }
export interface GreetingResult { text: string; selfReview: GreetingSelfReview }

const BUZZWORDS = /(赋能|闭环|抓手|有体感|自己扛|打法|降维|颗粒度)/
const URL_RX = /(https?:\/\/|www\.)[^\s]+/i

export function localGreetingChecks(text: string, maxChars: number, resumeSummary: string): string[] {
  const issues: string[] = []
  const n = Array.from(text).length
  if (n > maxChars) issues.push(`超过 ${maxChars} 字（${n} 字）`)
  if (n < 15) issues.push('太短，没有说明来意')
  if (BUZZWORDS.test(text)) issues.push('含包装词')
  const u = text.match(URL_RX); if (u && !resumeSummary.includes(u[0])) issues.push('出现了简历里没有的链接')
  if (/(贵公司.*(非常|十分).*(向往|仰慕)|请给我一个机会|期待您的回复，谢谢)/.test(text)) issues.push('有求职套话')
  return issues
}

export function trimToLimit(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  const cut = chars.slice(0, maxChars).join('')
  const idx = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('，'))
  return (idx >= Math.floor(maxChars * 0.5) ? cut.slice(0, idx + 1) : cut).replace(/[，；]$/, '。')
}

export async function composeGreeting(llm: LLM, input: GreetingInput): Promise<GreetingResult> {
  const maxChars = input.maxChars ?? 120
  const system = `以求职者本人身份写一条 Boss 直聘打招呼私信。
要求：
1. 不超过 ${maxChars} 字（含标点），最多 3 句；第一句就点明"应聘什么岗位 + 我最相关的一项真实经历/结果"，最重要的信息放最前面。
2. 只能用"我的背景"里的事实，不得编造经历、头衔、数据；不复述 JD；不提自己的短板。
3. 像本人说话：具体动作和结果，不用赋能/闭环/抓手等包装词，不写求职套话，不硬补邀约。
4. 不写简历里没有的链接。
只输出 JSON：{"text":"招呼语正文"}`
  const user = JSON.stringify({ job: input.job, 我的背景: input.resumeSummary, 用户偏好: input.preference ?? null })
  const gen = async (critique?: string) => {
    const msgs = [{ role: 'user' as const, content: critique ? `${user}\n\n上一版问题：${critique}。请重写。` : user }]
    const res = await llm.complete({ system, messages: msgs, json: true, temperature: 0.6 })
    try { return String(extractJson<{ text?: string }>(res.text).text ?? '').trim() } catch { return res.text.trim() }
  }
  let text = await gen()
  let issues = localGreetingChecks(text, maxChars, input.resumeSummary)
  if (issues.length) { const again = await gen(issues.join('；')); const i2 = localGreetingChecks(again, maxChars, input.resumeSummary); if (i2.length <= issues.length) { text = again; issues = i2 } }
  if (Array.from(text).length > maxChars) { text = trimToLimit(text, maxChars); issues = localGreetingChecks(text, maxChars, input.resumeSummary) }
  const review: GreetingSelfReview = { chars: Array.from(text).length, withinLimit: Array.from(text).length <= maxChars, issues }
  if (input.review !== false) {
    try {
      const res = await llm.complete({ system: '你是严格的招呼语评审。只输出 JSON：{"score":1-10,"key_info_first":true|false,"critique":"20字内改进建议"}', messages: [{ role: 'user', content: `岗位：${input.job.title}${input.job.company ? ' @ ' + input.job.company : ''}\n招呼语：${text}\n评审维度：自然度、与岗位相关、最重要信息是否在最前面、是否克制不堆砌。` }], json: true, temperature: 0 })
      const r = extractJson<{ score?: number; key_info_first?: boolean; critique?: string }>(res.text)
      review.score = r.score; review.keyInfoFirst = r.key_info_first; review.critique = r.critique
    } catch (e) { review.issues.push(`评审失败：${e instanceof Error ? e.message : String(e)}`) }
  }
  return { text, selfReview: review }
}
