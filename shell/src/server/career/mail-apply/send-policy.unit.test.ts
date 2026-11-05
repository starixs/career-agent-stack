/**
 * 放权（第三轮 R2）：decideMailSend 的七条顺序各一例。放权只来自他的动作（总开关 / 给「邮件投递」盖章）。
 */
import type { Repos } from '@career/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAIL_TRUST_KEY, MAIL_TRUST_LABEL } from '../../../shared/careerMailApply';
import { setAutoMode } from '../submit-policy';
import { setTargetJob } from '../targets';
import { createMemoryRepos } from '../test-db';
import { delegate, recordSuccess, revoke } from '../trust-ledger';
import { decideMailSend, mailAutoSendOn } from './send-policy';

describe('邮件发不发要不要他先看', () => {
  let r: Repos;
  let appId: string;
  let jobId: string;

  beforeEach(() => {
    r = createMemoryRepos();
    jobId = r.upsertJob({ source_platform: 'manual', title: '产品实习生', company_name: '甲科技', apply_email: 'hr@jia.com' }).id;
    appId = r.createApplication(jobId).id;
  });
  const mail = (extra: Record<string, unknown> = {}) => r.enqueueAction('send_mail', { to: 'hr@jia.com', subject: 's', body: 'b', purpose: 'apply', application_id: appId, ...extra }, appId);
  const decide = (extra: Record<string, unknown> = {}, blockers: string[] = []) => decideMailSend(r, { action: mail(extra), blockers, applicationId: appId });
  const delegateMail = () => { recordSuccess(r, { key: MAIL_TRUST_KEY, label: MAIL_TRUST_LABEL, kind: 'system' }); delegate(r, MAIL_TRUST_KEY); };

  it('1 差东西：不放（总开关开着也不放）', () => {
    setAutoMode(r, true);
    expect(decide({}, ['availability'])).toMatchObject({ approve: false });
  });

  it('2 跟进、回信、退信重发：不放', () => {
    setAutoMode(r, true);
    expect(decide({ purpose: 'followup' })).toMatchObject({ approve: false });
    expect(decide({ purpose: 'reply' })).toMatchObject({ approve: false });
    expect(decide({ bounced_from: 'old@jia.com' })).toMatchObject({ approve: false });
  });

  it('3 目标岗位：不放', () => {
    setAutoMode(r, true);
    setTargetJob(r, jobId, true);
    expect(decide()).toMatchObject({ approve: false, reason: expect.stringContaining('目标岗位') });
  });

  it('4 带他专门要求的：不放', () => {
    setAutoMode(r, true);
    expect(decide({ has_notes: true })).toMatchObject({ approve: false });
  });

  it('5 总开关开着：放，批准人 auto', () => {
    setAutoMode(r, true);
    expect(decide()).toMatchObject({ approve: true, by: 'auto' });
    expect(mailAutoSendOn(r)).toBe(true);
  });

  it('6 「邮件投递」这一类盖过章：放，批准人 delegated；收回后不放', () => {
    delegateMail();
    expect(decide()).toMatchObject({ approve: true, by: 'delegated' });
    expect(mailAutoSendOn(r)).toBe(true);
    revoke(r, MAIL_TRUST_KEY);
    expect(decide()).toMatchObject({ approve: false });
  });

  it('7 都没有：不放；做通几封（没盖章）也不会自己放', () => {
    for (let i = 0; i < 5; i++) recordSuccess(r, { key: MAIL_TRUST_KEY, label: MAIL_TRUST_LABEL, kind: 'system' });
    expect(decide()).toMatchObject({ approve: false });
    expect(mailAutoSendOn(r)).toBe(false);
  });
});
