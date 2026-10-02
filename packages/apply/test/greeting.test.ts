import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { GreetingScheduler, composeGreeting, localGreetingChecks, trimToLimit } from '../src/index.js'
import { mem } from './helpers.js'

const at = (h: number, m = 0) => new Date(2026, 9, 2, h, m, 0)

describe('GreetingScheduler', () => {
  it('时间窗：9-12 / 14-18 内可发，之外不可', () => {
    const repos = mem(); let now = at(10)
    const s = new GreetingScheduler(repos, {}, { clock: () => now, rng: () => 0 })
    expect(s.canSendNow().ok).toBe(true)
    now = at(13); const r = s.canSendNow(); expect(r.ok).toBe(false); if (!r.ok) { expect(r.reason).toBe('outside_window'); expect(r.waitMs).toBe(3600_000) }
    now = at(20); const r2 = s.canSendNow(); expect(r2.ok === false && r2.reason).toBe('outside_window')
  })
  it('每日上限 30，记录按天计数；随机间隔生效', () => {
    const repos = mem(); let now = at(10)
    const s = new GreetingScheduler(repos, { minGapMs: 60_000, maxGapMs: 60_000 }, { clock: () => now, rng: () => 0 })
    for (let i = 0; i < 30; i++) { s.recordSent(); now = new Date(now.getTime() + 61_000) }
    expect(s.sentToday()).toBe(30)
    const r = s.canSendNow(); expect(r.ok === false && r.reason).toBe('daily_cap')
    const s2 = new GreetingScheduler(mem(), { minGapMs: 60_000, maxGapMs: 60_000 }, { clock: () => now, rng: () => 0 })
    s2.recordSent(); now = new Date(now.getTime() + 10_000)
    const g = s2.canSendNow(); expect(g.ok === false && g.reason).toBe('gap'); if (!g.ok) expect(g.waitMs).toBe(50_000)
    now = new Date(now.getTime() + 60_000); expect(s2.canSendNow().ok).toBe(true)
  })
  it('风险锁：锁定期间不可发，过期自动解除；与 RiskGuard 共用一把锁', () => {
    const repos = mem(); let now = at(10)
    const s = new GreetingScheduler(repos, {}, { clock: () => now })
    s.lockForRisk(15, 'captcha', '滑块')
    const r = s.canSendNow(); expect(r.ok === false && r.reason).toBe('risk_lock')
    expect(repos.kvGet('apply:risk_lock:boss')).toBeTruthy()
    now = at(10, 16); expect(s.canSendNow().ok).toBe(true)
  })
})

describe('composeGreeting', () => {
  it('≤120 字、附自检；过长时重写一次再硬截', async () => {
    const long = '你好，' + '我做过推荐系统重构，'.repeat(20)
    const llm = new FakeLLM([JSON.stringify({ text: long }), JSON.stringify({ text: '你好，应聘算法实习生：我在 A 公司把离线特征计算从 6h 压到 40min，方便聊聊吗？' }), JSON.stringify({ score: 8, key_info_first: true, critique: '可以' })])
    const r = await composeGreeting(llm, { job: { title: '算法实习生', company: 'B 公司' }, resumeSummary: '推荐系统重构：6h→40min' })
    expect(Array.from(r.text).length).toBeLessThanOrEqual(120)
    expect(r.selfReview).toMatchObject({ withinLimit: true, score: 8, keyInfoFirst: true })
    expect(llm.calls.length).toBe(3)
    expect(llm.calls[0].system).toContain('最重要的信息放最前面')
  })
  it('本地检查：包装词 / 陌生链接 / 超长；trimToLimit 在句读处截断', () => {
    expect(localGreetingChecks('赋能业务闭环 http://evil.com 你好你好你好你好', 120, '')).toEqual(expect.arrayContaining(['含包装词', '出现了简历里没有的链接']))
    const t = trimToLimit('第一句很重要。第二句补充说明，第三句更多内容', 12)
    expect(t).toBe('第一句很重要。')
  })
})
