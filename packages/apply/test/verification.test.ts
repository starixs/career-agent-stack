import { describe, it, expect, vi } from 'vitest'
import { driveApplication, submitApplication, FakePage, RiskGuard } from '../src/index.js'
import { noLLM, profile, mem } from './helpers.js'

const quiet = { pause: [0, 0] as [number, number], settleMs: 0, sleep: async () => {} }
const pages = [
  { url: 'https://x.com/login', login: true, fields: [{ label: '手机' }] },
  { url: 'https://x.com/form', fields: [{ label: '姓名' }], buttons: ['提交申请'] },
]

describe('verification integration', () => {
  it('approved submit handles a post-click challenge without clicking submit twice', async () => {
    const page = new FakePage([
      { url: 'https://x.com/form', fields: [{ label: '姓名', value: '张三' }], buttons: [{ text: '提交申请', submit: true, goto: 'https://x.com/check' }] },
      { url: 'https://x.com/check', captcha: true },
      { url: 'https://x.com/done', text: '投递成功' },
    ])
    const verify = async () => {
      if (page.url().endsWith('/check')) { await page.goto('https://x.com/done'); return { status: 'changed' as const } }
      return { status: 'unchanged' as const }
    }
    const result = await submitApplication(page, { verify, pollMs: 1, timeoutMs: 20 })
    expect(result.status).toBe('submitted')
    expect(page.actions.filter(a => a.kind === 'click')).toHaveLength(1)
  })
  it('verification failure after submit preserves handoff and never retries submission', async () => {
    const page = new FakePage({ url: 'https://x.com/form', fields: [{ label: '姓名', value: '张三' }], buttons: [{ text: '提交申请', submit: true }] })
    const verify = vi.fn().mockResolvedValueOnce({ status: 'unchanged' }).mockResolvedValue({ status: 'needs_user' })
    const result = await submitApplication(page, { verify, pollMs: 1, timeoutMs: 20 })
    expect(result.status).toBe('handoff')
    expect(page.actions.filter(a => a.kind === 'click')).toHaveLength(1)
  })
  it('login verification completes before risk lock / LLM and continues filling in the same run', async () => {
    const page = new FakePage(pages)
    const guard = new RiskGuard(mem())
    const verify = vi.fn(async () => {
      if (page.url().endsWith('/login')) { await page.goto('https://x.com/form'); return { status: 'changed' as const } }
      return { status: 'unchanged' as const }
    })
    const result = await driveApplication(page, noLLM(), profile, { ...quiet, verify, riskGuard: guard })
    expect(result.status).toBe('stopped_before_submit')
    expect(page.valueOf('姓名')).toBe('张三')
    expect(page.submitted).toBe(false)
    expect(guard.shouldStop().stop).toBe(false)
  })
  it('failed verification hands off without sending the code field to LLM', async () => {
    const page = new FakePage({ url: 'https://x.com/form', fields: [{ label: '邮箱验证码' }] })
    const result = await driveApplication(page, noLLM(), profile, { ...quiet, verify: async () => ({ status: 'needs_user' }) })
    expect(result.status).toBe('handoff')
    expect(page.actions.filter(a => a.kind === 'fill')).toHaveLength(0)
  })
  it('does not invoke verification for authenticator or rate limit', async () => {
    for (const text of ['two-factor authenticator', 'too many requests']) {
      const verify = vi.fn(async () => ({ status: 'changed' as const }))
      const page = new FakePage({ url: 'https://x.com/form', text, fields: [{ label: '姓名' }] })
      await driveApplication(page, noLLM(), profile, { ...quiet, verify, riskGuard: new RiskGuard(mem()) })
      expect(verify).not.toHaveBeenCalled()
    }
  })
  it('rechecks verification triggered during fill before any next/submit action', async () => {
    const page = new FakePage({ url: 'https://x.com/form', fields: [{ label: '姓名' }], buttons: ['下一步'] })
    const verify = vi.fn().mockResolvedValueOnce({ status: 'unchanged' }).mockResolvedValue({ status: 'needs_user' })
    const result = await driveApplication(page, noLLM(), profile, { ...quiet, verify })
    expect(result.status).toBe('handoff')
    expect(verify).toHaveBeenCalledTimes(2)
    expect(page.actions.some(a => a.kind === 'click' && a.target === 'button:下一步')).toBe(false)
  })
})
