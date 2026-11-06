/**
 * 邮件投递工作台（第四轮）：五站各一例、站的优先级、失败、不列已关掉的和网申、direct_send 三态、不带邮件内容。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Application, Job, MailMessage } from '@career/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIL_TRUST_KEY } from '../../../shared/careerMailApply';
import { asksFor } from '../delivery';
import { setAutoMode } from '../submit-policy';
import { delegate, recordSuccess } from '../trust-ledger';
import { mailBoard, mailBoardRows } from './board';
import { saveMailSetup } from './setup';
import { mailFixture, type MailFixture } from './test-fixture';

const DAY = 86_400_000;

describe('邮件投递工作台', () => {
  let dir: string;
  let f: MailFixture;
  let accountId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'career-mail-board-'));
    f = await mailFixture(dir);
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
    accountId = f.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' }).id;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const mailJob = (company: string, extra: Partial<Job> = {}): Job =>
    f.repos.upsertJob({ source_platform: 'manual', source_job_id: company, title: '产品实习生', company_name: company, apply_email: `hr@${company}.com`, location: '上海', ...extra });
  const app = (company: string, extra: Partial<Job> = {}): Application => f.repos.createApplication(mailJob(company, extra).id);
  const pendingSend = (a: Application, payload: Record<string, unknown> = {}) =>
    f.repos.enqueueAction('send_mail', { to: 'hr@x.com', subject: '应聘', body: '正文', purpose: 'apply', application_id: a.id, job_id: a.job_id, ...payload }, a.id);
  const out = (a: Application, daysAgo = 2) => f.repos.insertMailMessage({ account_id: accountId, uid: null, message_id: `<o-${a.id}@qq.com>`, in_reply_to: null, direction: 'out', from_addr: 'me@qq.com', to_addr: 'hr@x.com', subject: '应聘', snippet: '', body_text: '正文', received_at: new Date(Date.now() - daysAgo * DAY).toISOString(), relevance: 'job', kind: null, inbox_item_id: null, application_id: a.id, action_id: null })!;
  const sent = (company: string, daysAgo = 2) => {
    const a = app(company);
    const row = out(a, daysAgo);
    f.repos.jumpTo(a.id, 'applied', '邮件投递已发送', { submission_evidence: `mail:${row.id}` });
    return { a, row };
  };
  const incoming = (a: Application, kind: MailMessage['kind'], from = 'hr@x.com', subject = 'Re: 应聘') => f.repos.insertMailMessage({ account_id: accountId, uid: null, message_id: `<i-${Math.random()}@x>`, in_reply_to: null, direction: 'in', from_addr: from, to_addr: 'me@qq.com', subject, snippet: '', body_text: '', received_at: new Date().toISOString(), relevance: 'job', kind, inbox_item_id: null, application_id: a.id, action_id: null });
  const rowOf = (company: string) => mailBoardRows(f.deps).find(r => r.company.name === company);

  it('五站各一例：可以投 / 在写 / 等你 / 已发出 / 有回音', () => {
    mailJob('ready', { deadline: '2099-12-31T00:00:00.000Z' });
    const writing = app('writing');
    f.repos.enqueueAction('draft_mail', { job_id: writing.job_id, application_id: writing.id, to: 'hr@writing.com' }, writing.id, true);
    const waiting = app('waiting');
    const send = pendingSend(waiting);
    const s = sent('sent', 3);
    const r = sent('replied', 5);
    incoming(r.a, 'interview_invite');
    expect(rowOf('ready')).toMatchObject({ station: 'ready', key: rowOf('ready')!.job_id, application_id: null, deadline: '2099-12-31', city: '上海', waiting: null });
    expect(rowOf('writing')).toMatchObject({ station: 'writing', application_id: writing.id });
    const ask = asksFor(f.repos).find(a => a.mail?.action_ids.includes(send.id))!;
    expect(rowOf('waiting')).toMatchObject({ station: 'waiting', waiting: 'apply', action_id: send.id, ask_id: ask.id });
    expect(rowOf('sent')).toMatchObject({ station: 'sent', sent_at: s.row.received_at, reply_kind: null });
    expect(rowOf('replied')).toMatchObject({ station: 'replied', reply_kind: 'interview_invite', sent_at: r.row.received_at });
    // 不带任何邮件内容
    const json = JSON.stringify(mailBoard(f.deps));
    for (const secret of ['hr@x.com', '正文', '应聘']) expect(json).not.toContain(secret);
  });

  it('等你的六种：投递 / 回信 / 再争取 / 被退回 / 没写成 / 没发出去', () => {
    const kinds: Array<[string, Record<string, unknown>]> = [['a', {}], ['b', { purpose: 'reply' }], ['c', { purpose: 'followup' }], ['d', { bounced_from: 'hr@x.com' }]];
    for (const [c, p] of kinds) pendingSend(app(c), p);
    const draft = app('e');
    f.repos.setActionStatus(f.repos.enqueueAction('draft_mail', { job_id: draft.job_id, application_id: draft.id, to: 'hr@e.com' }, draft.id, true).id, 'failed', { error: '邮件没写成，再试一次' });
    const failedSend = app('g');
    f.repos.setActionStatus(pendingSend(failedSend).id, 'failed', { error: 'connect ETIMEDOUT' });
    expect(['a', 'b', 'c', 'd', 'e', 'g'].map(c => rowOf(c)?.waiting)).toEqual(['apply', 'reply', 'followup', 'bounced', 'failed_draft', 'failed_send']);
    expect(rowOf('e')).toMatchObject({ action_id: null, ask_id: asksFor(f.repos).find(a => a.mail_failed?.stage === 'draft')!.id });
    expect(rowOf('g')!.ask_id).toBe(asksFor(f.repos).find(a => a.mail_failed?.stage === 'send')!.id);
  });

  it('优先级：已发出又有待审的跟进 → 等你；有回音的阶段走过 applied 也算回音；自动回复不算', () => {
    const fu = sent('fu', 8);
    pendingSend(fu.a, { purpose: 'followup' });
    expect(rowOf('fu')).toMatchObject({ station: 'waiting', waiting: 'followup' });
    const auto = sent('auto');
    incoming(auto.a, 'application_received');
    expect(rowOf('auto')!.station).toBe('sent');
    const human = sent('human');
    incoming(human.a, 'other');
    expect(rowOf('human')).toMatchObject({ station: 'replied', reply_kind: 'reply' });
    const rejected = sent('rejected');
    f.repos.jumpTo(rejected.a.id, 'rejected');
    expect(rowOf('rejected')).toMatchObject({ station: 'replied', reply_kind: 'rejection' });
  });

  it('不列：已关掉的、网申的、过了截止的', () => {
    const skipped = app('skipped');
    pendingSend(skipped);
    f.repos.jumpTo(skipped.id, 'skip');
    f.repos.upsertJob({ source_platform: 'campus', source_job_id: 'web', title: '后端', company_name: 'web', url: 'https://web.test/apply' });
    mailJob('late', { deadline: '2020-01-01T00:00:00.000Z' });
    const names = mailBoardRows(f.deps).map(r => r.company.name);
    expect(names).not.toContain('skipped');
    expect(names).not.toContain('web');
    expect(names).not.toContain('late');
  });

  it('写好直接发三态：off → 盖章 delegated（账本里还没有这一类也能盖）→ 总开关开着 auto；收回回到 off', () => {
    expect(mailBoard(f.deps).setup).toMatchObject({ direct_send: 'off', mailbox: { account_id: accountId, address: 'me@qq.com' }, portfolio_url: null, files: [] });
    expect(saveMailSetup(f.deps, { direct_send: true }).direct_send).toBe('delegated');
    setAutoMode(f.repos, true);
    expect(mailBoard(f.deps).setup.direct_send).toBe('auto');
    setAutoMode(f.repos, false);
    expect(saveMailSetup(f.deps, { direct_send: false }).direct_send).toBe('off');
    recordSuccess(f.repos, { key: MAIL_TRUST_KEY, label: '邮件投递', kind: 'system' });
    delegate(f.repos, MAIL_TRUST_KEY);
    expect(mailBoard(f.deps).setup.direct_send).toBe('delegated');
    expect(() => saveMailSetup(f.deps, { portfolio_url: 'nope' })).toThrow('这不像一个网址');
    expect(saveMailSetup(f.deps, { portfolio_url: 'https://me.example.com' }).portfolio_url).toBe('https://me.example.com');
  });
});

describe('邮件投递工作台 · 还没有简历', () => {
  let dir: string;
  let f: MailFixture;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'career-mail-board-nores-')); f = await mailFixture(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('没简历：写了投递邮箱的岗位仍在「可以投」、has_resume 为 false；已投过的仍不列；放一份简历后 has_resume 为 true', () => {
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'nores', title: '产品实习生', company_name: '甲科技', apply_email: 'hr@jia.com' });
    const done = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'done', title: '产品实习生', company_name: '乙数据', apply_email: 'hr@yi.com' });
    f.repos.jumpTo(f.repos.createApplication(done.id).id, 'applied', '网申已提交', { submission_evidence: 'submit:x' });
    const board = mailBoard(f.deps);
    expect(board.rows.map(r => [r.job_id, r.station])).toEqual([[job.id, 'ready']]);
    expect(board.setup.has_resume).toBe(false);
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
    expect(mailBoard(f.deps).setup.has_resume).toBe(true);
  });
});
