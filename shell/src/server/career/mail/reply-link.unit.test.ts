/**
 * 发出之后的来信认回（P2.2 三级、P2.3 退信、P2.4 自动回复）：只读库的判断。
 */
import type { Repos } from '@career/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryRepos } from '../test-db';
import { bareAddress, isBounce, isNotificationMail, linkReply, locateBounced, pickBySubject, reSubject } from './reply-link';
import { isAutoReply } from './rules';

const NOW = '2026-11-10T08:00:00.000Z';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

describe('来信认回', () => {
  let r: Repos;
  let accountId: string;

  beforeEach(() => {
    r = createMemoryRepos();
    accountId = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' }).id;
  });

  /** 发出一封挂在申请上的信。 */
  function sent(company: string, title: string, to: string, at: string, messageId: string | null = null) {
    const job = r.upsertJob({ source_platform: 'manual', source_job_id: `${company}-${title}`, title, company_name: company });
    const app = r.createApplication(job.id);
    const row = r.insertMailMessage({ account_id: accountId, uid: null, message_id: messageId, in_reply_to: null, direction: 'out', from_addr: 'me@qq.com', to_addr: to, subject: `应聘【${title}】`, snippet: '', body_text: '', received_at: at, relevance: 'job', kind: null, inbox_item_id: null, application_id: app.id, action_id: null })!;
    return { app, row };
  }

  it('地址与标题的小工具', () => {
    expect(bareAddress('"HR 张" <HR@Jia.com>')).toBe('hr@jia.com');
    expect(bareAddress('hr@jia.com')).toBe('hr@jia.com');
    expect(bareAddress('没有地址')).toBeNull();
    expect(reSubject('应聘【产品实习生】')).toBe('Re: 应聘【产品实习生】');
    expect(reSubject('RE: 应聘')).toBe('RE: 应聘');
    expect(reSubject('回复：应聘')).toBe('回复：应聘');
    expect(pickBySubject([{ title: '运营' }, { title: '产品' }], '关于产品岗位')).toEqual({ title: '产品' });
    expect(pickBySubject([{ title: '运营' }, { title: '产品' }], '你好')).toEqual({ title: '运营' });
  });

  it('① In-Reply-To 命中我们发出的信', () => {
    const { app } = sent('甲', '产品实习生', 'hr@jia.com', ago(2), '<out1@qq.com>');
    expect(linkReply(r, { in_reply_to: '<out1@qq.com>', from: 'someone@else.com', subject: 'Re: 应聘' })).toMatchObject({ application_id: app.id, via: 'in_reply_to' });
  });

  it('② 发件地址 = 当初收件人（另一个主题、大小写不同也认）', () => {
    const { app } = sent('甲', '产品实习生', 'hr@jia.com', ago(2));
    expect(linkReply(r, { in_reply_to: null, from: '张老师 <HR@JIA.com>', subject: '想问一下到岗时间' })).toMatchObject({ application_id: app.id, via: 'sender' });
  });

  it('② 同一个地址对应几份申请：主题里含哪份岗位名用哪份，都不含用最近发出的那份', () => {
    const older = sent('甲', '产品实习生', 'hr@jia.com', ago(5));
    const newer = sent('甲', '运营实习生', 'hr@jia.com', ago(1));
    expect(linkReply(r, { in_reply_to: null, from: 'hr@jia.com', subject: '关于产品实习生的面试' })?.application_id).toBe(older.app.id);
    expect(linkReply(r, { in_reply_to: null, from: 'hr@jia.com', subject: '你好' })?.application_id).toBe(newer.app.id);
  });

  it('③ 都不中：不认（走原路径）', () => {
    sent('甲', '产品实习生', 'hr@jia.com', ago(2), '<out1@qq.com>');
    expect(linkReply(r, { in_reply_to: '<nobody@x>', from: 'hr@yi.com', subject: 'Re: 应聘' })).toBeNull();
    expect(linkReply(r, { in_reply_to: null, from: null, subject: '' })).toBeNull();
  });

  it('退信识别：发件人或主题', () => {
    expect(isBounce({ from: 'MAILER-DAEMON@qq.com', subject: '你好' })).toBe(true);
    expect(isBounce({ from: 'Mail Delivery Subsystem <postmaster@x.com>', subject: 'x' })).toBe(true);
    expect(isBounce({ from: 'a@x.com', subject: 'Undelivered Mail Returned to Sender' })).toBe(true);
    expect(isBounce({ from: 'a@x.com', subject: '系统退信' })).toBe(true);
    expect(isBounce({ from: 'hr@jia.com', subject: '面试邀请' })).toBe(false);
  });

  it('退的是哪封：In-Reply-To 命中；否则 3 天内发出、收件地址出现在退信正文里的那封；认不出不猜', () => {
    const a = sent('甲', '产品实习生', 'hr@jia.com', ago(1), '<a@qq.com>');
    const b = sent('乙', '产品实习生', 'nobody@yi.com', ago(1));
    const old = sent('丙', '产品实习生', 'old@bing.com', ago(5));
    expect(locateBounced(r, { in_reply_to: '<a@qq.com>', text: '' }, NOW)?.id).toBe(a.row.id);
    expect(locateBounced(r, { in_reply_to: null, text: 'The following address failed: <NOBODY@yi.com>' }, NOW)?.id).toBe(b.row.id);
    expect(locateBounced(r, { in_reply_to: null, text: 'failed: old@bing.com' }, NOW)).toBeNull();
    expect(locateBounced(r, { in_reply_to: null, text: '没有写地址' }, NOW)).toBeNull();
    expect(old.row.id).toBeTruthy();
  });

  it('自动回复：主题或正文开头', () => {
    expect(isAutoReply({ subject: '自动回复：应聘【产品实习生】', text: '' })).toBe(true);
    expect(isAutoReply({ subject: 'Automatic reply: 应聘', text: '' })).toBe(true);
    expect(isAutoReply({ subject: 'Re: 应聘', text: '您好，已收到您的邮件，我们会尽快处理。' })).toBe(true);
    expect(isAutoReply({ subject: 'Out of Office', text: '' })).toBe(true);
    expect(isAutoReply({ subject: 'Re: 应聘', text: '同学你好，想问一下你最早什么时候能到岗？' })).toBe(false);
  });

  it('②′ 同公司另一个地址：发件域名 = 已发收件人的域名就认回；同域名多份按主题挑', () => {
    const product = sent('甲', '产品实习生', 'hr@jia.com', ago(5));
    const ops = sent('甲', '运营实习生', 'campus@jia.com', ago(1));
    expect(linkReply(r, { in_reply_to: null, from: '面试官 <interview@JIA.com>', subject: '产品实习生一面安排' })).toMatchObject({ application_id: product.app.id, via: 'domain' });
    expect(linkReply(r, { in_reply_to: null, from: 'boss@jia.com', subject: '面试安排' })).toMatchObject({ application_id: ops.app.id, via: 'domain' });
  });

  it('②′ 公共邮箱域名、招聘系统代发域名不按域名认回', () => {
    sent('小作坊', '产品实习生', 'boss123@qq.com', ago(1));
    sent('乙', '产品实习生', 'campus@mokahr.com', ago(1));
    expect(linkReply(r, { in_reply_to: null, from: 'zhang@qq.com', subject: '你好' })).toBeNull();
    expect(linkReply(r, { in_reply_to: null, from: 'noreply@mokahr.com', subject: '【丙】笔试通知' })).toBeNull();
    expect(linkReply(r, { in_reply_to: null, from: 'boss123@qq.com', subject: '你好' })).toMatchObject({ via: 'sender' });
  });

  it('通知型来信：noreply 一类地址、招聘系统代发、正文写着系统自动发送；真人不算', () => {
    expect(isNotificationMail({ from: 'noreply@jia.com', text: '面试通知' })).toBe(true);
    expect(isNotificationMail({ from: 'Notifications <notification@jia.com>', text: '' })).toBe(true);
    expect(isNotificationMail({ from: '甲科技 <hr@mokahr.com>', text: '面试通知' })).toBe(true);
    expect(isNotificationMail({ from: 'hr@jia.com', text: '此邮件由系统自动发送，请勿回复。' })).toBe(true);
    expect(isNotificationMail({ from: '王老师 <wang@jia.com>', text: '同学你好，你最早什么时候能到岗？' })).toBe(false);
  });
});
