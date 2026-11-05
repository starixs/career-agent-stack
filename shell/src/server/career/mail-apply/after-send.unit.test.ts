/**
 * 通知型来信不起草回信（第三轮 R4）：规则说是通知就不起草，哪怕模型判了要回；真人问话照样起草。
 */
import type { MailMessage, Repos } from '@career/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadCore } from '../core-module';
import { createMemoryRepos } from '../test-db';
import { afterLinkedReply } from './after-send';

const core = await loadCore();

describe('认回的来信要不要起草回信', () => {
  let r: Repos;
  let appId: string;
  let accountId: string;
  let uid = 0;

  beforeEach(() => {
    r = createMemoryRepos();
    accountId = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' }).id;
    appId = r.createApplication(r.upsertJob({ source_platform: 'manual', title: '产品实习生', company_name: '甲科技', apply_email: 'hr@jia.com' }).id).id;
  });
  const incoming = (from: string, text: string): MailMessage => r.insertMailMessage({
    account_id: accountId, uid: ++uid, message_id: `<n${uid}@x>`, in_reply_to: null, direction: 'in', from_addr: from, to_addr: 'me@qq.com', subject: '关于你的申请',
    snippet: text.slice(0, 200), body_text: text, received_at: new Date().toISOString(), relevance: 'job', kind: 'other', inbox_item_id: null, application_id: appId, action_id: null,
  })!;
  const replyDrafts = () => r.listActions().filter(a => a.kind === 'draft_mail' && JSON.parse(a.payload_json).purpose === 'reply');
  const run = (row: MailMessage) => afterLinkedReply({ repos: r, core, llm: null, broadcast: () => undefined, sessionId: () => 'global' }, appId, row, { kind: 'other', needs_reply: true });

  it('三种通知（noreply 地址、招聘系统代发、正文写着系统自动发送）：模型说要回也不起草', () => {
    run(incoming('noreply@jia.com', '请确认你的面试时间。'));
    run(incoming('甲科技校园招聘 <hr@mokahr.com>', '请回复确认是否参加。'));
    run(incoming('hr@jia.com', '请确认参加宣讲会。此邮件由系统自动发送，请勿回复。'));
    expect(replyDrafts()).toEqual([]);
  });

  it('真人问话：起草一封回信', () => {
    const row = incoming('王老师 <wang@jia.com>', '同学你好，想问一下你最早什么时候能到岗？');
    run(row);
    expect(replyDrafts().map(a => JSON.parse(a.payload_json).reply_to_mail_id)).toEqual([row.id]);
  });
});
