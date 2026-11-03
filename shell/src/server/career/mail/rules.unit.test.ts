import { describe, expect, it } from 'vitest';

import { classifyByRules, companyOf } from './rules';

const m = (subject: string, from = 'noreply@mokahr.com', text = '') => ({ subject, from, text });

describe('companyOf', () => {
  it('主题里的【】「」、开头的「X 校园招聘」、发件人名字都能取出公司', () => {
    expect(companyOf(m('【美团】已收到您的简历'))).toBe('美团');
    expect(companyOf(m('「小红书」笔试通知'))).toBe('小红书');
    expect(companyOf(m('字节跳动2026校园招聘笔试通知'))).toBe('字节跳动');
    expect(companyOf(m('笔试通知', '京东集团校园招聘 <campus@jd.com>'))).toBe('京东');
  });

  it('招聘平台名、泛称不算公司', () => {
    expect(companyOf(m('【Moka】您有一条新的通知'))).toBeNull();
    expect(companyOf(m('您有一条新的通知', '牛客招聘 <a@nowcoder.com>'))).toBeNull();
    expect(companyOf(m('面试邀请', 'hr@a.com'))).toBeNull();
  });
});

describe('classifyByRules', () => {
  it('按主题判类型：拒信优先于面试，录用优先于面试', () => {
    expect(classifyByRules(m('【腾讯】面试结果：很遗憾'))?.kind).toBe('rejection');
    expect(classifyByRules(m('【腾讯】录用意向书'))?.kind).toBe('offer');
    expect(classifyByRules(m('【腾讯】面试邀请'))?.kind).toBe('interview_invite');
    expect(classifyByRules(m('【网易】感谢您的投递'))?.kind).toBe('application_received');
    expect(classifyByRules(m('【米哈游】在线测评邀请'))?.kind).toBe('assessment');
  });

  it('面试、笔试从正文抠时间；投递确认不带时间', () => {
    expect(classifyByRules(m('【腾讯】面试邀请', 'hr@tencent.com', '诚邀您参加 9月15日 14:00 一面'))?.fields).toEqual({ company: '腾讯', when: '9月15日 14:00' });
    expect(classifyByRules(m('【网易】感谢您的投递', 'hr@163.com', '9月1日 已收到'))?.fields).toEqual({ company: '网易' });
  });

  it('认不出类型或公司就不下结论', () => {
    expect(classifyByRules(m('【美团】双十一优惠'))).toBeNull();
    expect(classifyByRules(m('面试邀请', 'hr@a.com'))).toBeNull();
  });
});
