import { describe, it, expect } from 'vitest'
import { isSubmitText, isNextText, detectObstacle, detectRateLimit, boss } from '../src/index.js'

const sig = (text: string, extra: Partial<{ url: string; title: string; hasPasswordInput: boolean; captchaDom: boolean }> = {}) => ({ url: 'https://x.com/a', title: '', text, hasPasswordInput: false, captchaDom: false, ...extra })

describe('guards', () => {
  it('SUBMIT 守卫命中各种提交文案，下一步不命中', () => {
    for (const t of ['提交', '确认提交', '提交申请', '立即投递', 'Submit', 'Apply Now', '投递简历']) expect(isSubmitText(t)).toBe(true)
    for (const t of ['下一步', '保存并下一步', 'Next', 'Continue', '继续']) { expect(isSubmitText(t)).toBe(false); expect(isNextText(t)).toBe(true) }
    expect(isNextText('提交')).toBe(false)
    expect(isSubmitText('立即沟通', boss)).toBe(true)
  })
  it('阻碍检测：2FA / 验证码 / 登录 / 测评', () => {
    expect(detectObstacle(sig('请输入身份验证器中的动态口令'))?.reason).toBe('2fa')
    expect(detectObstacle(sig('请拖动滑块完成拼图'))?.reason).toBe('captcha')
    expect(detectObstacle(sig('', { captchaDom: true }))?.reason).toBe('captcha')
    expect(detectObstacle(sig('', { hasPasswordInput: true }))?.reason).toBe('login')
    expect(detectObstacle(sig('欢迎', { url: 'https://x.com/login?next=/apply' }))?.reason).toBe('login')
    expect(detectObstacle(sig('请先登录后继续申请'))?.reason).toBe('login')
    expect(detectObstacle(sig('请在 30 分钟内完成在线测评'))?.reason).toBe('assessment')
    expect(detectObstacle(sig('姓名 手机 邮箱 提交'))).toBeNull()
    expect(detectObstacle(sig('当前IP地址可能存在异常访问行为'), boss)?.reason).toBe('captcha')
  })
  it('限流提示', () => {
    expect(detectRateLimit('访问过于频繁，请稍后再试')).toBeTruthy()
    expect(detectRateLimit('一切正常')).toBeNull()
  })
})
