import { describe, expect, it } from 'vitest';

import { extractCode, parseMapTime, smsSignature } from './sms-code';

// 2026-11-03 小米 10 / 华为 Pura 70 实测读到的真实格式
const FEISHU = '【飞书招聘】MetaApp验证码：355161，请在 5 分钟内完成登录。如非本人操作，请忽略。';
const FEISHU_LONG = '【飞书招聘】广州库洛科技有限公司验证码：161049，请在 5 分钟内完成登录。如非本人操作，请忽略。';
const MOKA = '【Moka招聘】您的验证码为030928，有效期15分钟。';
const ZHILIAN = '【智联招聘】验证码：021643，10分钟内有效。切勿将验证码提供给他人，智联工作人员不会向您索要验证码，谨防被骗。';
const MEITUAN = '【美团】账号登录验证码：675054，该验证码10分钟内有效，限本次使用，请勿泄露验证码。';

describe('extractCode', () => {
  it.each([[FEISHU, '355161'], [FEISHU_LONG, '161049'], [MOKA, '030928'], [ZHILIAN, '021643'], [MEITUAN, '675054']])('真实短信 %#', (body, code) => {
    expect(extractCode(body)).toBe(code);
  });

  it('码在关键词前面', () => {
    expect(extractCode('482913是您的验证码，5分钟内有效【某某网申】')).toBe('482913');
    expect(extractCode('Your verification code is 7731')).toBe('7731');
  });

  it('前导 0 保留（按字符串）', () => {
    expect(extractCode('验证码：000123')).toBe('000123');
  });

  it('不是验证码短信：不取', () => {
    expect(extractCode('【南航】尊敬的旅客，您的航班CZ3105已于14:00起飞')).toBeNull();
    expect(extractCode('快递单号 773123456789 已签收')).toBeNull();
  });

  it('有效期数字不被当成码', () => {
    expect(extractCode('【某站】验证码 5821，10分钟内有效')).toBe('5821');
  });
});

describe('smsSignature', () => {
  it('开头或结尾的【签名】', () => {
    expect(smsSignature(FEISHU)).toBe('飞书招聘');
    expect(smsSignature('482913是您的验证码【北森测评】')).toBe('北森测评');
    expect(smsSignature('没有签名 1234')).toBeNull();
  });
});

describe('parseMapTime', () => {
  it('手机本地时间按时区转 ISO', () => {
    expect(parseMapTime('20261103T122707', 480)).toBe('2026-11-03T04:27:07.000Z');
  });
  it('格式不对返回 null', () => {
    expect(parseMapTime('', 480)).toBeNull();
    expect(parseMapTime('2026-11-03', 480)).toBeNull();
  });
});
