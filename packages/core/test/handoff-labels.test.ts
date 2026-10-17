import { describe, expect, it } from 'vitest'
import { HANDOFF_REASONS, handoffReasonLabel } from '@career/core'

describe('handoffReasonLabel', () => {
  it('labels every handoff reason in Chinese', () => {
    for (const reason of HANDOFF_REASONS) expect(handoffReasonLabel(reason)).not.toMatch(/[a-z]/)
    expect(handoffReasonLabel('captcha')).toBe('验证码')
    expect(handoffReasonLabel('login')).toBe('登录')
  })
  it('never echoes an unknown enum back to the user', () => {
    expect(handoffReasonLabel('rate_limit')).toBe('有一步要你来')
  })
})
