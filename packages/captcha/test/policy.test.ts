import { describe, it, expect } from 'vitest'
import { CaptchaPolicy, siteKeyOf } from '../src/policy.js'

const T0 = 1_700_000_000_000

describe('CaptchaPolicy 预算与冷却', () => {
  it('当天次数超预算后拒绝', () => {
    const p = new CaptchaPolicy({ siteDailyBudget: 3, now: () => T0 })
    expect(p.canAttempt('a.com').ok).toBe(true)
    for (let i = 0; i < 3; i++) p.record('a.com', 'slider', 'failed')
    const v = p.canAttempt('a.com')
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('cooldown') // 连败优先触发冷却
    expect(p.dailyCount('a.com')).toBe(3)
  })
  it('连败冷却期过了放行，但预算仍按当天计', () => {
    let t = T0
    const p = new CaptchaPolicy({ siteDailyBudget: 3, siteCooldownMs: 1000, minIntervalMs: 0, now: () => t })
    p.record('a.com', 'slider', 'failed')
    expect(p.canAttempt('a.com').reason).toBe('cooldown')
    t += 1001
    expect(p.canAttempt('a.com').ok).toBe(true)
    p.record('a.com', 'slider', 'failed')
    p.record('a.com', 'slider', 'failed')
    t += 1001
    const v = p.canAttempt('a.com')
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('daily_budget')
  })
  it('通过会清掉连败段', () => {
    let t = T0
    const p = new CaptchaPolicy({ siteCooldownMs: 1000, minIntervalMs: 0, now: () => t })
    p.record('a.com', 'slider', 'failed')
    p.record('a.com', 'slider', 'passed')
    expect(p.canAttempt('a.com').ok).toBe(true)
  })
  it('站点之间互不影响；gave_up 不占预算', () => {
    const p = new CaptchaPolicy({ siteDailyBudget: 1, now: () => T0 })
    p.record('a.com', 'slider', 'failed')
    p.record('b.com', 'slider', 'gave_up')
    expect(p.dailyCount('b.com')).toBe(0)
    expect(p.canAttempt('b.com').ok).toBe(true)
  })
  it('审计日志只读', () => {
    const p = new CaptchaPolicy({ now: () => T0 })
    p.record('a.com', 'slider', 'passed')
    const log = p.audit()
    expect(log.length).toBe(1)
    expect(() => { (log as AttemptRecordMutable[]).pop() }).not.toThrow() // 不崩，但不影响内部
    expect(p.audit().length).toBe(1)
  })
})

interface AttemptRecordMutable { pop(): unknown }

describe('siteKeyOf', () => {
  it('取 hostname；坏 URL 原样返回', () => {
    expect(siteKeyOf('https://www.zhipin.com/apply?x=1')).toBe('www.zhipin.com')
    expect(siteKeyOf('not a url')).toBe('not a url')
  })
})

describe('CaptchaPolicy 最短间隔', () => {
  it('同站刚结束一次验证，立即重复会被 rate_limit；间隔后恢复', () => {
    let t = T0
    const p = new CaptchaPolicy({ minIntervalMs: 1500, siteCooldownMs: 0, now: () => t })
    p.record('a.com', 'slider', 'passed')
    expect(p.canAttempt('a.com')).toEqual({ ok: false, reason: 'rate_limit' })
    t += 1501
    expect(p.canAttempt('a.com').ok).toBe(true)
  })
})
