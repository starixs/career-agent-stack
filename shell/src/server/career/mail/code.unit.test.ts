import { describe, expect, it } from 'vitest';

import { extractMailCode } from './code';

describe('extractMailCode', () => {
  it('取紧跟在激活码 / 验证码后面的那串（2026-11-03 中国中车注册）', () => {
    expect(extractMailCode({ subject: '中国中车招聘系统-邮箱激活', text: '您好！您的激活码为：483920，30 分钟内有效。客服电话 400-123-4567' })).toBe('483920');
    expect(extractMailCode({ subject: 'Verification code', text: 'Your verification code is A7K29Q. It expires in 10 minutes.' })).toBe('A7K29Q');
  });
  it('码在前、字在后：退到唯一像码的数字', () => {
    expect(extractMailCode({ subject: '【HotJob】注册验证', text: '773104 是您的验证码' })).toBe('773104');
  });
  it('不是验证码信不取', () => {
    expect(extractMailCode({ subject: '面试邀请', text: '请于 2026 年 11 月 5 日 14:00 参加面试' })).toBeNull();
  });
});
