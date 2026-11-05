/**
 * 发前过目：预览、改、存到岗信息、发出。
 * 预览与发送走同一个解析函数（看到的就是发出去的）；解不开的资料、自己的邮箱当收件人、没连邮箱都挡住不发；
 * 存到岗信息只重排代码拼的那几样、不调模型；他改过的标题不替他重排；改动存回去是占位符。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyJobs } from '../batch-apply';
import { asksFor } from '../delivery';
import { retryFailedAsk } from '../fill-failures';
import { loadCore } from '../core-module';
import { setMailCredentialsPath, setMailPassword } from '../mail/credentials';
import { executeApprovedSendMails, type SendMailPayload } from '../mail/send';
import { handleCareerRoute } from '../../routes/career';
import { saveAvailability } from './availability';
import { draftMailForAction } from './drafter';
import { MailDraftError, patchMailDraft } from './edit';
import { parseSendMailPayload } from './payload';
import { internJd, mailFixture, modelMail, PERSON, type FixtureProfile, type MailFixture } from './test-fixture';
import { mailDraftView } from './view';

vi.mock('../../sse', () => ({ broadcast: vi.fn() }));

const core = await loadCore();

describe('发前过目', () => {
  let dir: string;
  let f: MailFixture;

  async function drafted(opts: { profile?: FixtureProfile; mailbox?: boolean } = {}) {
    f = await mailFixture(dir, { profile: opts.profile });
    if (opts.mailbox !== false) setMailPassword(f.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' }).id, 'code');
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'j1', title: '产品实习生', company_name: '甲科技', jd_raw: internJd('甲科技', 'jia') });
    const res = await applyJobs(f.deps, [job.id]);
    f.llm.push(modelMail());
    await draftMailForAction(f.deps, f.repos.getAction(res.started[0])!);
    return f.repos.listActions('pending_review').find(a => a.kind === 'send_mail')!;
  }
  const view = (id: string) => mailDraftView(f.deps, f.repos.getAction(id)!);
  const sendDeps = (sent: SendMailPayload[]) => ({ repos: f.repos, core, llm: null, broadcast: () => undefined, sessionId: () => 'global', vault: f.vault, transport: async (_a: unknown, _p: string, m: SendMailPayload) => { sent.push(m); return { messageId: '<m@x>' }; } });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-mail-view-')); setMailCredentialsPath(join(dir, 'creds.json')); });
  afterEach(() => { setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('预览与发送一致：存好到岗信息后批准，发出去的就是预览里的那封', async () => {
    const send = await drafted();
    saveAvailability(f.deps, { days_per_week: '5', months: '3', start: '两周内' });
    const v = view(send.id);
    expect(v).toMatchObject({ company: '甲科技', role: '产品实习生', from: { address: 'me@qq.com' }, blockers: [], purpose: 'apply', thread: null });
    expect(v.resume_options.map(o => o.label)).toEqual(['产品方向（按这个岗位改过）', '产品方向']);
    const sent: SendMailPayload[] = [];
    f.repos.reviewActions([send.id], 'approved');
    expect((await executeApprovedSendMails(sendDeps(sent), [send.id]))[0].ok).toBe(true);
    expect(sent[0]).toMatchObject({ to: v.to, subject: v.subject, body: v.body });
    expect(sent[0].attachments?.map(a => a.filename)).toEqual(v.attachments.map(a => a.filename));
    expect(sent[0].body).toContain('最早两周内到岗');
  });

  it('资料里没手机号：预览标 unresolved；批准了也不发，放回待发（不是失败）', async () => {
    const send = await drafted({ profile: { phone: '' } });
    saveAvailability(f.deps, { days_per_week: '4', months: '6', start: '随时' });
    expect(view(send.id).blockers).toEqual(['unresolved']);
    const sent: SendMailPayload[] = [];
    f.repos.reviewActions([send.id], 'approved');
    const [r] = await executeApprovedSendMails(sendDeps(sent), [send.id]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('还有资料没填');
    expect(sent).toHaveLength(0);
    expect(f.repos.getAction(send.id)!.status).toBe('pending_review');
  });

  it('收件人改成自己的邮箱（已连的或资料里的）、或不像邮箱：bad_recipient', async () => {
    const send = await drafted();
    for (const to of ['me@qq.com', 'ME@QQ.com', PERSON.email, 'hr']) {
      expect((await patchMailDraft(f.deps, send.id, { to })).blockers).toContain('bad_recipient');
    }
    expect((await patchMailDraft(f.deps, send.id, { to: 'campus@jia.com' })).blockers).not.toContain('bad_recipient');
  });

  it('没连邮箱：no_mailbox；连上之后自动用第一个邮箱', async () => {
    const send = await drafted({ mailbox: false });
    expect(view(send.id).blockers).toContain('no_mailbox');
    expect(view(send.id).from).toBeNull();
    f.repos.upsertMailAccount({ provider: '163', address: 'me@163.com', imap_host: 'imap.163.com', smtp_host: 'smtp.163.com' });
    expect(view(send.id).from?.address).toBe('me@163.com');
    expect(view(send.id).blockers).not.toContain('no_mailbox');
  });

  it('存到岗信息：只重排到岗那句和代码拼的标题，不调模型；他改过的标题不动', async () => {
    const send = await drafted();
    const second = await (async () => {
      const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'j2', title: '运营实习生', company_name: '乙数据', jd_raw: internJd('乙数据', 'yi') });
      const res = await applyJobs(f.deps, [job.id]);
      f.llm.push(modelMail());
      await draftMailForAction(f.deps, f.repos.getAction(res.started[0])!);
      return f.repos.listActions('pending_review').find(a => a.kind === 'send_mail' && a.id !== send.id)!;
    })();
    await patchMailDraft(f.deps, second.id, { subject: '我自己写的标题' });
    const calls = f.llm.calls.length;
    const views = saveAvailability(f.deps, { days_per_week: '3', months: '4', start: '下个月' });
    expect(f.llm.calls).toHaveLength(calls);
    expect(views.find(v => v.action_id === send.id)?.subject).toBe(`应聘【产品实习生】-华东大学-${PERSON.name}-每周3天-可实习4个月`);
    expect(views.find(v => v.action_id === second.id)?.subject).toBe('我自己写的标题');
    expect(views.every(v => v.body.includes('我每周可实习3天，可连续实习4个月，最早下个月到岗。'))).toBe(true);
    expect(f.vault.profileSafeBasics()).toMatchObject({ internDaysPerWeek: '3', internMonths: '4', availableDate: '下个月' });
  });

  it('改正文：存回去是占位符，subject_auto 只在改了标题时才关；换简历重新冻结附件', async () => {
    const send = await drafted();
    const before = view(send.id);
    const after = await patchMailDraft(f.deps, send.id, { body: `${before.body}\n电话 ${PERSON.phone}`, subject: before.subject });
    expect(after.body).toContain(PERSON.phone);
    const p = parseSendMailPayload(send.id, f.repos.getAction(send.id)!.payload_json);
    expect(p.body).not.toContain(PERSON.phone);
    expect(p.body).toContain('{{vault:profile.phone}}');
    expect(p.subject_auto).toBe(true);
    const master = f.store.listResumeMasters()[0];
    const swapped = await patchMailDraft(f.deps, send.id, { resume_id: master.id });
    expect(swapped.attachments[0]).toMatchObject({ resume_id: master.id, tailored_changes: null, filename: before.attachments[0].filename });
    expect(parseSendMailPayload(send.id, f.repos.getAction(send.id)!.payload_json).packet_id).not.toBe(p.packet_id);
  });

  it('发送失败出声：等你里「1 封没发出去」，授权问题单独说；再试一次 = 放回待发让他再点，不自动重发', async () => {
    const send = await drafted();
    saveAvailability(f.deps, { days_per_week: '4', months: '6', start: '随时' });
    f.repos.reviewActions([send.id], 'approved');
    const failing = { ...sendDeps([]), transport: async () => { throw new Error('Invalid login: 535 Authentication failed'); } };
    expect((await executeApprovedSendMails(failing, [send.id]))[0].ok).toBe(false);
    expect(f.repos.getAction(send.id)!.status).toBe('failed');
    const ask = asksFor(f.repos).find(a => a.kind === 'failed')!;
    expect(ask).toMatchObject({ title: '1 封没发出去', detail: '邮箱授权失效了，重新连一下邮箱', action_ids: [send.id] });
    expect(retryFailedAsk(f.repos, ask.id)).toEqual([send.id]);
    expect(f.repos.getAction(send.id)!.status).toBe('pending_review');
    expect(asksFor(f.repos).find(a => a.mail)?.mail?.action_ids).toEqual([send.id]);
  });

  it('没写成：等你里「1 封没写成」，再试一次 = 放回队列重写', async () => {
    f = await mailFixture(dir);
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'j9', title: '产品实习生', company_name: '甲科技', jd_raw: internJd('甲科技', 'jia') });
    const draft = f.repos.getAction((await applyJobs(f.deps, [job.id])).started[0])!;
    f.llm.push(() => { throw new Error('502'); }).push(() => { throw new Error('502'); });
    await draftMailForAction(f.deps, draft);
    const ask = asksFor(f.repos).find(a => a.kind === 'failed')!;
    expect(ask).toMatchObject({ title: '1 封没写成', detail: '邮件没写成，再试一次' });
    expect(retryFailedAsk(f.repos, ask.id)).toEqual([draft.id]);
    expect(f.repos.getAction(draft.id)!.status).toBe('approved');
  });

  it('发出去的、不存在的不能改；不投这家 = 拒绝 + drop，申请跳过', async () => {
    const send = await drafted();
    await expect(patchMailDraft(f.deps, 'act_nope', { body: 'x' })).rejects.toBeInstanceOf(MailDraftError);
    const res = await handleCareerRoute('/api/career/actions/review', new Request('http://local/api/career/actions/review', { method: 'POST', body: JSON.stringify({ ids: [send.id], decision: 'rejected', drop: true }) }),
      { repos: f.repos, vault: f.vault, llm: null, broadcast: () => undefined, exportsDir: dir, studioExport: false });
    expect(res!.status).toBe(200);
    expect(f.repos.getAction(send.id)!.status).toBe('rejected');
    expect(f.repos.getApplication(send.application_id!)!.stage).toBe('skip');
    await expect(patchMailDraft(f.deps, send.id, { body: 'x' })).rejects.toBeInstanceOf(MailDraftError);
  });
});
