import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLLM } from '@career/core';

import { loadCore } from '../core-module';
import { createMemoryRepos } from '../test-db';
import { deleteMailPassword, getMailPassword, setMailCredentialsPath, setMailPassword } from './credentials';
import { detectProvider, presetFor } from './providers';
import { executeSendMailAction } from './send';
import { isLikelyJobMail, syncMailAccount, type FetchedMail } from './sync';

vi.mock('../../sse', () => ({ broadcast: vi.fn() }));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-mail-')); setMailCredentialsPath(join(dir, 'creds.json')); });
afterEach(() => { setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

async function deps(llm: FakeLLM | null) {
  const repos = createMemoryRepos();
  const core = await loadCore();
  const events: Array<{ event: string; data: unknown }> = [];
  return { repos, core, llm, broadcast: (event: string, data: unknown) => events.push({ event, data }), sessionId: () => 'global', events };
}
const mail = (over: Partial<FetchedMail>): FetchedMail => ({ uid: 1, message_id: '<m1@x>', in_reply_to: null, from: 'hr@a.com', to: 'me@qq.com', subject: '面试邀请', text: '诚邀您参加一面', received_at: '2026-10-03T01:00:00Z', ...over });

describe('providers / credentials', () => {
  it('按域名识别预设；授权码文件 0600 且可删', () => {
    expect(detectProvider('a@qq.com')).toBe('qq');
    expect(detectProvider('a@163.com')).toBe('163');
    expect(detectProvider('a@gmail.com')).toBe('gmail');
    expect(detectProvider('a@company.cn')).toBe('imap');
    expect(presetFor('qq')?.smtp_port).toBe(465);
    setMailPassword('acc1', 'secret');
    expect(getMailPassword('acc1')).toBe('secret');
    expect(statSync(join(dir, 'creds.json')).mode & 0o777).toBe(0o600);
    deleteMailPassword('acc1');
    expect(getMailPassword('acc1')).toBeNull();
  });
  it('粗筛：求职关键词或招聘系统发件人才进模型，验证码 / 退订不进', () => {
    expect(isLikelyJobMail({ from: 'noreply@shop.com', subject: '您的订单已发货', text: '' })).toBe(false);
    expect(isLikelyJobMail({ from: 'x@mokahr.com', subject: '通知', text: '' })).toBe(true);
    expect(isLikelyJobMail({ from: 'a@b.com', subject: '笔试安排', text: '' })).toBe(true);
    expect(isLikelyJobMail({ from: 'a@b.com', subject: '验证码', text: '123456' })).toBe(false);
  });
});

describe('syncMailAccount', () => {
  it('新邮件落库、求职邮件归档到卷宗、无关邮件忽略、last_uid 前进、重复 uid 跳过', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    const job = d.repos.upsertJob({ source_platform: 'manual', title: '运营', company_name: '甲公司' });
    const app = d.repos.createApplication(job.id);
    const account = d.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    llm.push(JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '甲公司', when: '2026-10-06T02:00:00Z', round: 'hr' }, match: { application_id: app.id }, summary: '甲公司 HR 面' }));
    const fetched = [mail({ uid: 5 }), mail({ uid: 6, from: 'news@shop.com', subject: '双十一优惠', text: '买买买' })];
    const res = await syncMailAccount({ ...d, fetchNew: async () => fetched }, account);
    expect(res).toMatchObject({ fetched: 2, stored: 2, job_related: 1, ignored: 1 });
    expect(d.repos.getMailAccount(account.id)).toMatchObject({ status: 'ok', last_uid: 6 });
    expect(d.repos.getApplication(app.id)!.stage).toBe('interview');
    const msgs = d.repos.listMailMessages({ application_id: app.id });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ relevance: 'job', kind: 'interview_invite' });
    expect(d.repos.listDossierNotes(app.id).some(n => n.kind === 'mail')).toBe(true);
    // 再同步同一批：全部去重
    const again = await syncMailAccount({ ...d, fetchNew: async () => fetched }, account);
    expect(again.stored).toBe(0);
    expect(llm.calls).toHaveLength(1);
  });
  it('没有授权码 → auth_failed；拉取抛错 → 记录错误不抛出', async () => {
    const d = await deps(null);
    const account = d.repos.upsertMailAccount({ provider: '163', address: 'me@163.com', imap_host: 'imap.163.com', smtp_host: 'smtp.163.com' });
    expect((await syncMailAccount(d, account)).error).toContain('授权码');
    expect(d.repos.getMailAccount(account.id)!.status).toBe('auth_failed');
    setMailPassword(account.id, 'x');
    const res = await syncMailAccount({ ...d, fetchNew: async () => { throw new Error('Invalid credentials (Failure)'); } }, account);
    expect(res.error).toContain('Invalid');
    expect(d.repos.getMailAccount(account.id)!.status).toBe('auth_failed');
  });
});

describe('executeSendMailAction', () => {
  it('只发送已批准的 send_mail；成功后记邮件、卷宗、素材使用并推进到 applied', async () => {
    const d = await deps(null);
    const job = d.repos.upsertJob({ source_platform: 'manual', title: '后端', company_name: '乙公司' });
    const app = d.repos.createApplication(job.id);
    const account = d.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    const action = d.repos.enqueueAction('send_mail', { account_id: account.id, to: 'hr@b.com', subject: '应聘后端', body: '正文', application_id: app.id }, app.id);
    await expect(executeSendMailAction(d, action)).rejects.toThrow('尚未批准');
    d.repos.reviewActions([action.id], 'approved');
    const sent: unknown[] = [];
    const res = await executeSendMailAction({ ...d, transport: async (_a, _p, m) => { sent.push(m); return { messageId: '<out1@x>' }; } }, d.repos.getAction(action.id)!);
    expect(sent).toHaveLength(1);
    expect(d.repos.getAction(action.id)!.status).toBe('done');
    expect(d.repos.getMailMessage(res.mail_id)).toMatchObject({ direction: 'out', message_id: '<out1@x>', application_id: app.id });
    expect(d.repos.getApplication(app.id)!.stage).toBe('applied');
    expect(d.repos.listMaterialUses({ application_id: app.id })[0].context).toBe('邮件');
    expect(d.events.some(e => e.event === 'career:focus')).toBe(true);
  });
  it('发送失败 → 动作 failed 并抛错', async () => {
    const d = await deps(null);
    const account = d.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    const action = d.repos.enqueueAction('send_mail', { account_id: account.id, to: 'hr@b.com', subject: 's', body: 'b' });
    d.repos.reviewActions([action.id], 'approved');
    await expect(executeSendMailAction({ ...d, transport: async () => { throw new Error('SMTP 535'); } }, d.repos.getAction(action.id)!)).rejects.toThrow('发送失败');
    expect(d.repos.getAction(action.id)!.status).toBe('failed');
  });
});
