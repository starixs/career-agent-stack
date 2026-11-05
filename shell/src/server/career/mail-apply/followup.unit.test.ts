/**
 * 没回音满一周的跟进（P2.6）：到期判定的每个条件各一个反例；一生只跟一次；来了回音撤回挂着的跟进。
 */
import type { Application, Repos } from '@career/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryRepos } from '../test-db';
import { cancelPendingFollowUps, dueFollowups, FOLLOWUP_AFTER_DAYS, runFollowupSweep } from './followup';

const NOW = '2026-11-20T08:00:00.000Z';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString();

describe('跟进到期', () => {
  let r: Repos;
  let accountId: string;

  beforeEach(() => {
    r = createMemoryRepos();
    accountId = r.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' }).id;
  });

  /** 一份邮件投出的申请：投递邮件 sentDaysAgo 天前发出，阶段 applied、证据 mail:。 */
  function mailed(company: string, sentDaysAgo = FOLLOWUP_AFTER_DAYS + 1, job: { deadline?: string } = {}): Application {
    const j = r.upsertJob({ source_platform: 'manual', source_job_id: company, title: '产品实习生', company_name: company, apply_email: `hr@${company}.com`, ...job });
    const app = r.createApplication(j.id);
    const row = r.insertMailMessage({ account_id: accountId, uid: null, message_id: `<${company}@qq.com>`, in_reply_to: null, direction: 'out', from_addr: 'me@qq.com', to_addr: `hr@${company}.com`, subject: '应聘', snippet: '', body_text: '', received_at: ago(sentDaysAgo), relevance: 'job', kind: null, inbox_item_id: null, application_id: app.id, action_id: null })!;
    return r.jumpTo(app.id, 'applied', '邮件投递已发送', { submission_evidence: `mail:${row.id}` });
  }
  function incoming(app: Application, kind: 'interview_invite' | 'application_received' | null, daysAgo: number, from = 'hr@x.com', subject = 'Re: 应聘') {
    const row = r.insertMailMessage({ account_id: accountId, uid: null, message_id: `<in-${Math.random()}@x>`, in_reply_to: null, direction: 'in', from_addr: from, to_addr: 'me@qq.com', subject, snippet: '', body_text: '', received_at: ago(daysAgo), relevance: 'job', kind, inbox_item_id: null, application_id: app.id, action_id: null })!;
    return row;
  }
  const dueIds = () => dueFollowups(r, NOW).map(d => d.application_id);

  it('满一周、没回音、没跟过、岗位开着：到期', () => {
    const app = mailed('jia');
    expect(dueIds()).toEqual([app.id]);
  });

  it('反例：不满 7 天', () => {
    mailed('jia', FOLLOWUP_AFTER_DAYS - 1);
    expect(dueIds()).toEqual([]);
  });

  it('反例：阶段不是 applied（已有回音推进到面试）', () => {
    const app = mailed('jia');
    r.jumpTo(app.id, 'interview');
    expect(dueIds()).toEqual([]);
  });

  it('反例：不是邮件投出的（网申证据）', () => {
    const j = r.upsertJob({ source_platform: 'campus', source_job_id: 'web', title: '后端', company_name: '戊', url: 'https://x.test' });
    const app = r.createApplication(j.id);
    r.jumpTo(app.id, 'applied', '网申已提交', { submission_evidence: 'https://x.test/done' });
    expect(dueIds()).toEqual([]);
  });

  it('反例：发出之后来过回音；自动回复 / 投递确认和退信不算回音', () => {
    const heard = mailed('jia');
    incoming(heard, null, 2);
    const auto = mailed('yi');
    incoming(auto, 'application_received', 7);
    const bounced = mailed('bing');
    incoming(bounced, null, 7, 'MAILER-DAEMON@qq.com', '系统退信');
    expect(dueIds().sort()).toEqual([auto.id, bounced.id].sort());
  });

  it('反例：跟进过（包括他点了「不跟了」的）', () => {
    const app = mailed('jia');
    const f = r.enqueueAction('send_mail', { to: 'hr@jia.com', subject: 'Re: 应聘', body: 'x', purpose: 'followup', application_id: app.id }, app.id);
    r.reviewActions([f.id], 'rejected', 'user');
    expect(dueIds()).toEqual([]);
  });

  it('反例：岗位过了截止 / 关闭了', () => {
    mailed('jia', FOLLOWUP_AFTER_DAYS + 1, { deadline: ago(1) });
    const closed = mailed('yi');
    r.db.update('job', closed.job_id, { source_status: 'closed' });
    expect(dueIds()).toEqual([]);
  });

  it('扫一次排一封（系统批准的 draft_mail，purpose followup）；再扫不重复', () => {
    const app = mailed('jia');
    const ids = runFollowupSweep(r, NOW);
    expect(ids).toHaveLength(1);
    expect(r.getAction(ids[0])).toMatchObject({ kind: 'draft_mail', status: 'approved', approved_by: 'system', application_id: app.id });
    expect(JSON.parse(r.getAction(ids[0])!.payload_json)).toMatchObject({ purpose: 'followup', reply_to_mail_id: app.submission_evidence!.slice(5) });
    expect(runFollowupSweep(r, NOW)).toEqual([]);
  });

  it('来了回音：挂着的跟进与回信作废（系统作的）；投递邮件、退信重发不动', () => {
    const app = mailed('jia');
    const follow = r.enqueueAction('send_mail', { to: 'hr@jia.com', subject: 'Re', body: 'x', purpose: 'followup' }, app.id);
    const reply = r.enqueueAction('draft_mail', { purpose: 'reply', job_id: app.job_id, application_id: app.id, reply_to_mail_id: 'm' }, app.id, true);
    const resend = r.enqueueAction('send_mail', { to: 'hr@jia.com', subject: 's', body: 'b', purpose: 'apply', bounced_from: 'hr@jia.com' }, app.id);
    expect(cancelPendingFollowUps(r, app.id, '对方回信了').sort()).toEqual([follow.id, reply.id].sort());
    expect(r.getAction(follow.id)!.status).toBe('rejected');
    expect(JSON.parse(r.getAction(follow.id)!.result_json!)).toEqual({ reason: '对方回信了', by: 'system' });
    expect(r.getAction(reply.id)!.status).toBe('rejected');
    expect(r.getAction(resend.id)!.status).toBe('pending_review');
  });
});
