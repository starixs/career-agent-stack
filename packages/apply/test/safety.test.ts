import { describe, it, expect } from 'vitest'
import { RiskGuard } from '../src/index.js'
import { mem } from './helpers.js'

describe('RiskGuard', () => {
  it('trip 写入 kv 风险锁，shouldStop 为真，过期后解除', () => {
    const repos = mem(); let now = new Date('2026-10-02T10:00:00Z')
    const g = new RiskGuard(repos, { platform: 'beisen', lockMinutes: 30, clock: () => now })
    expect(g.shouldStop().stop).toBe(false)
    g.trip('captcha', '滑块')
    expect(g.shouldStop()).toMatchObject({ stop: true, reason: 'captcha' })
    expect(repos.kvGet('apply:risk_lock:beisen')).toMatchObject({ reason: 'captcha' })
    now = new Date('2026-10-02T10:31:00Z'); expect(g.shouldStop().stop).toBe(false)
  })
  it('没有每日页数上限：打开多少页都只计数，不叫停（用户 2026-10-30「不要做上限」）', () => {
    const g = new RiskGuard(mem(), { platform: 'x' })
    for (let i = 0; i < 500; i++) g.countPage()
    expect(g.pagesToday()).toBe(500)
    expect(g.shouldStop().stop).toBe(false)
  })
  it('inspect：验证码 / 登录墙 / 限流即 trip', () => {
    const g = new RiskGuard(mem(), { platform: 'x' })
    const base = { url: 'u', title: '', text: '', hasPasswordInput: false, captchaDom: false, buttons: [], fileInputs: 0, fieldCount: 0, errors: [] }
    expect(g.inspect({ ...base, text: '姓名 邮箱' })).toBeNull(); expect(g.shouldStop().stop).toBe(false)
    expect(g.inspect({ ...base, text: '访问过于频繁，请稍后再试' })?.reason).toBe('rate_limit'); expect(g.shouldStop().stop).toBe(true)
    const g2 = new RiskGuard(mem(), { platform: 'y' })
    expect(g2.inspect({ ...base, hasPasswordInput: true })?.reason).toBe('login'); expect(g2.shouldStop().reason).toBe('login')
  })
})
