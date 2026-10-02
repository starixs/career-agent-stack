import { describe, it, expect } from 'vitest'
import { FakePage, RiskGuard, classifyCaptcha, describeObstacle, driveApplication, looksLikeRiskUrl, riskBackoffMinutes } from '../src/index.js'
import { mem, profile, noLLM } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }

describe('阻碍分层', () => {
  it('验证码细分：滑块 / 点选 / 短信 / 图形 / 浏览器检查', () => {
    expect(classifyCaptcha({ title: '', text: '请拖动滑块完成拼图' })).toBe('slider')
    expect(classifyCaptcha({ title: '', text: '请按顺序点击图中的文字' })).toBe('image_click')
    expect(classifyCaptcha({ title: '', text: '验证码已发送至手机 请输入短信验证码' })).toBe('sms')
    expect(classifyCaptcha({ title: '', text: '请输入图形验证码 看不清换一张' })).toBe('image_text')
    expect(classifyCaptcha({ title: 'Just a moment...', text: 'Checking your browser' })).toBe('browser_check')
    expect(classifyCaptcha({ title: '', text: '安全验证' })).toBe('unknown')
  })
  it('describeObstacle 给出用户该做什么；登录已代填时提示不同', () => {
    expect(describeObstacle('captcha', { title: '', text: '拖动滑块' }).userAction).toContain('拖动滑块')
    expect(describeObstacle('login', { title: '', text: '' }).userAction).toContain('登录')
    expect(describeObstacle('login', { title: '', text: '' }, '', { loginFilled: ['username', 'password'] }).userAction).toContain('已代填')
    expect(describeObstacle('assessment', { title: '', text: '' }).userAction).toContain('测评')
  })
  it('drive 的 handoff 结果带 userAction 与 captchaKind', async () => {
    const page = new FakePage({ url: 'https://x.com/apply', fields: [{ label: '姓名' }], captcha: true })
    const r = await driveApplication(page, noLLM(), profile, quiet)
    expect(r.status).toBe('handoff'); expect(r.reason).toBe('captcha'); expect(r.captchaKind).toBe('slider')
    expect(r.userAction).toContain('滑块'); expect(r.message).toContain('滑块')
  })
  it('风控 URL：跳转到 verify / risk 页即上锁并 blocked', async () => {
    const repos = mem()
    const guard = new RiskGuard(repos, { platform: 'generic' })
    const page = new FakePage({ url: 'https://x.com/verify?from=apply', fields: [{ label: '姓名' }] })
    const r = await driveApplication(page, noLLM(), profile, { ...quiet, riskGuard: guard })
    expect(r.status).toBe('blocked'); expect(r.message).toContain('风控')
    expect(guard.lock()?.reason).toBe('rate_limit')
    expect(looksLikeRiskUrl('https://x.com/security-check')).toBe(true)
    expect(looksLikeRiskUrl('https://x.com/apply/verify-email')).toBe(true)
    expect(looksLikeRiskUrl('https://x.com/jobs/123')).toBe(false)
  })
  it('风险锁渐进退避：同一天第 1/2/3/4 次分别 30 分钟 / 2 小时 / 12 小时 / 24 小时', () => {
    expect([0, 1, 2, 3, 9].map(riskBackoffMinutes)).toEqual([30, 120, 720, 1440, 1440])
    const repos = mem()
    let now = new Date('2026-10-03T10:00:00Z')
    const guard = new RiskGuard(repos, { platform: 'boss', clock: () => now })
    const minutes = (until: string) => Math.round((new Date(until).getTime() - now.getTime()) / 60_000)
    expect(minutes(guard.trip('captcha').until)).toBe(30)
    expect(minutes(guard.trip('captcha').until)).toBe(120)
    expect(minutes(guard.trip('rate_limit').until)).toBe(720)
    expect(guard.tripsToday()).toBe(3)
    expect(minutes(guard.trip('rate_limit', '显式分钟数优先', 5).until)).toBe(5)
    now = new Date('2026-10-04T10:00:00Z') // 第二天重新计数
    expect(minutes(guard.trip('captcha').until)).toBe(30)
  })
})
