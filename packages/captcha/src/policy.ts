import type { CaptchaKind } from './types.js'

/**
 * 验证码自动求解策略：有预算才试，试不过就升级人工（L3），绝不硬碰。
 * 预算维度：单站点当天总次数 + 连续失败冷却 + 单次求解内部轮数（SolverDeps.maxAttempts）。
 * 本策略只决定能否尝试验证，不授予提交权限；最终投递必须仍由已批准的 submit 动作执行。
 */

export interface AttemptRecord {
  site: string
  kind: CaptchaKind
  at: number
  outcome: 'passed' | 'failed' | 'gave_up'
}

export interface CaptchaPolicyOptions {
  /** 单站点每天最多自动尝试次数（默认 6）。 */
  siteDailyBudget?: number
  /** 连续失败后同站点冷却毫秒（默认 10 分钟）。 */
  siteCooldownMs?: number
  /** 同站两次验证尝试的最短间隔（默认 1.2 秒），防止高频重复。 */
  minIntervalMs?: number
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1000

export class CaptchaPolicy {
  private readonly records: AttemptRecord[] = []
  private readonly dailyBudget: number
  private readonly cooldownMs: number
  private readonly minIntervalMs: number
  private readonly lastAttemptAt = new Map<string, number>()
  private readonly now: () => number

  constructor(opts: CaptchaPolicyOptions = {}) {
    this.dailyBudget = opts.siteDailyBudget ?? 6
    this.cooldownMs = opts.siteCooldownMs ?? 10 * 60 * 1000
    this.minIntervalMs = opts.minIntervalMs ?? 1200
    this.now = opts.now ?? Date.now
  }

  /** 记录一条尝试（进审计日志，并参与预算计算）。 */
  record(site: string, kind: CaptchaKind, outcome: AttemptRecord['outcome']): void {
    this.records.push({ site, kind, at: this.now(), outcome })
    if (outcome !== 'gave_up') this.lastAttemptAt.set(site, this.now())
  }

  /** 当天该站点已用掉的尝试次数。 */
  dailyCount(site: string): number {
    const t0 = this.now() - DAY_MS
    return this.records.filter(r => r.site === site && r.at > t0 && r.outcome !== 'gave_up').length
  }

  /** 同站点最近一次连续失败段的起点。 */
  private lastFailureAt(site: string): number | null {
    let at: number | null = null
    for (const r of this.records) {
      if (r.site !== site) continue
      if (r.outcome === 'failed') at = r.at
      else if (r.outcome === 'passed') at = null
    }
    return at
  }

  canAttempt(site: string): { ok: boolean; reason?: 'daily_budget' | 'cooldown' | 'rate_limit' } {
    const failedAt = this.lastFailureAt(site)
    if (failedAt !== null && this.now() - failedAt < this.cooldownMs) return { ok: false, reason: 'cooldown' }
    if (this.dailyCount(site) >= this.dailyBudget) return { ok: false, reason: 'daily_budget' }
    const last = this.lastAttemptAt.get(site)
    if (last !== undefined && this.now() - last < this.minIntervalMs) return { ok: false, reason: 'rate_limit' }
    return { ok: true }
  }

  /** 审计日志（副本，外部改动不落进内部状态）：复盘与风控回退的输入。 */
  audit(): readonly AttemptRecord[] { return this.records.slice() }
}

/** 从 URL 提取站点键。 */
export const siteKeyOf = (url: string): string => {
  try { return new URL(url).hostname } catch { return url }
}
