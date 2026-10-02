import type { Repos, HandoffReason } from '@career/core'
import type { PageSignals } from './scripts.js'
import type { SiteAdapter } from './adapters/types.js'
import { detectObstacle, detectRateLimit } from './guards.js'
import { riskBackoffMinutes } from './obstacles.js'

/**
 * RiskGuard：验证码 / 登录墙 / 限流提示 → trip(reason) 写入 kv 风险锁，shouldStop() 立刻为真；
 * 另有每日页数上限。锁按平台存（key: apply:risk_lock:<platform>），GreetingScheduler 也读同一把锁。
 */
export type RiskReason = HandoffReason | 'rate_limit' | 'daily_page_cap' | 'manual'
export interface RiskLock { until: string; reason: RiskReason; detail?: string; at: string }
export interface RiskGuardOptions { platform?: string; dailyPageCap?: number; lockMinutes?: number; clock?: () => Date }

export const riskLockKey = (platform: string) => `apply:risk_lock:${platform}`
export const pageCountKey = (platform: string, day: string) => `apply:pages:${platform}:${day}`
export const tripCountKey = (platform: string, day: string) => `apply:risk_trips:${platform}:${day}`
export const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export class RiskGuard {
  readonly platform: string
  readonly dailyPageCap: number
  readonly lockMinutes: number
  private clock: () => Date
  constructor(private repos: Repos, opts: RiskGuardOptions = {}) {
    this.platform = opts.platform ?? 'generic'
    this.dailyPageCap = opts.dailyPageCap ?? 300
    this.lockMinutes = opts.lockMinutes ?? 30
    this.clock = opts.clock ?? (() => new Date())
  }
  lock(): RiskLock | undefined {
    const l = this.repos.kvGet<RiskLock>(riskLockKey(this.platform))
    if (!l) return undefined
    return new Date(l.until).getTime() > this.clock().getTime() ? l : undefined
  }
  shouldStop(): { stop: boolean; reason?: RiskReason; until?: string; detail?: string } {
    const l = this.lock()
    if (l) return { stop: true, reason: l.reason, until: l.until, detail: l.detail }
    if (this.pagesToday() >= this.dailyPageCap) return { stop: true, reason: 'daily_page_cap', detail: `今日已打开 ${this.pagesToday()} 页，达到上限 ${this.dailyPageCap}` }
    return { stop: false }
  }
  /**
   * 写风险锁。minutes 缺省按当天第 n 次触发渐进退避（30 分钟 → 2 小时 → 12 小时 → 24 小时），
   * 构造参数 lockMinutes 作为第一次的下限。
   */
  trip(reason: RiskReason, detail?: string, minutes?: number): RiskLock {
    const now = this.clock()
    const day = dayOf(now)
    const trips = (this.repos.kvGet<number>(tripCountKey(this.platform, day)) ?? 0)
    this.repos.kvSet(tripCountKey(this.platform, day), trips + 1)
    const mins = minutes ?? Math.max(this.lockMinutes, riskBackoffMinutes(trips))
    const lock: RiskLock = { until: new Date(now.getTime() + Math.max(1, mins) * 60_000).toISOString(), reason, detail, at: now.toISOString() }
    this.repos.kvSet(riskLockKey(this.platform), lock)
    return lock
  }
  /** 当天已触发风控的次数（给用户看"今天已经被拦了几次"）。 */
  tripsToday(): number { return this.repos.kvGet<number>(tripCountKey(this.platform, dayOf(this.clock()))) ?? 0 }
  clear(): void { this.repos.kvSet(riskLockKey(this.platform), { until: new Date(0).toISOString(), reason: 'manual', at: this.clock().toISOString() }) }
  pagesToday(): number { return this.repos.kvGet<number>(pageCountKey(this.platform, dayOf(this.clock()))) ?? 0 }
  /** 打开一页前预留额度；超限返回 false（并不自动上锁，让调用方决定）。 */
  reservePage(): boolean {
    const n = this.pagesToday()
    if (n >= this.dailyPageCap) return false
    this.repos.kvSet(pageCountKey(this.platform, dayOf(this.clock())), n + 1)
    return true
  }
  /** 检查页面信号：验证码 / 登录墙 / 限流 → 自动 trip 并返回命中原因。 */
  inspect(sig: PageSignals, adapter?: SiteAdapter): { reason: RiskReason; evidence: string } | null {
    const rl = detectRateLimit(`${sig.title} ${sig.text}`)
    if (rl) { this.trip('rate_limit', rl); return { reason: 'rate_limit', evidence: rl } }
    const ob = detectObstacle(sig, adapter)
    if (ob && (ob.reason === 'captcha' || ob.reason === 'login' || ob.reason === '2fa')) { this.trip(ob.reason, ob.evidence); return ob }
    return null
  }
}
