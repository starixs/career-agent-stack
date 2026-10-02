import { describe, it, expect } from 'vitest'
import { FakePage, diagnosePage } from '../src/index.js'

describe('diagnose', () => {
  it('预检：字段数 / 文件上传 / 登录墙 / 反爬提示 / 不可达', async () => {
    const ok = await diagnosePage(new FakePage({ url: 'https://campus.beisen.com/apply', fields: [{ label: '姓名', required: true }, { label: '简历', type: 'file' }], buttons: ['下一步'] }))
    expect(ok).toMatchObject({ reachable: true, adapterId: 'beisen', needsLogin: false, fieldCount: 2, requiredCount: 1, hasFileUpload: true, hasNextButton: true, hasSubmitButton: false, looksLikeForm: true })
    const login = await diagnosePage(new FakePage({ url: 'https://x.com/login', login: true, fields: [{ label: '账号' }] }))
    expect(login.needsLogin).toBe(true); expect(login.obstacle).toBe('login')
    const anti = await diagnosePage(new FakePage({ url: 'https://x.com/a', text: '访问过于频繁，请稍后再试' }))
    expect(anti.antiBotHint).toBeTruthy(); expect(anti.looksLikeForm).toBe(false)
    const bad = await diagnosePage(new FakePage({ url: 'https://x.com/a' }), { url: 'https://nowhere.test/' })
    expect(bad.reachable).toBe(false)
  })
})
