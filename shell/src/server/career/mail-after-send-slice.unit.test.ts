/**
 * 链路切面「邮件投递 · 发出之后」（face-mail-apply 阶段二）：邮件发出去以后，这份申请还是我们管——
 * 回信自己挂回来，退信出声，对方等回话时回信已经写好，没回音满一周有一封写好的跟进；全程发信仍要他点头。
 *
 * 接着阶段一的情景：甲 / 乙 / 丙 3 封投递邮件已发出（第 0 天）→
 *  ① 第 1 天甲的 HR 换了个主题直接回信（没有 In-Reply-To，发件地址 = 当初收件人）问到岗时间 → 挂回甲；等你条「甲科技 回信了」；
 *     预览带对方原信、回信正文只用已确认的资料；点发出 → 发出去的信带 In-Reply-To。
 *  ② 第 2 天乙退信 → 乙不再是 applied、月度投出少一份；等你条「乙数据 · 邮件被退回」，blocker 是收件人；
 *     改地址后发出 → 乙回到 applied、岗位的投递邮箱换成新地址；同一封退信再来一次不重复排。
 *  ③ 第 3 天丙自动回复 → 归为确认信、阶段不动、不调模型。拨到第 8 天扫一次 → 只有丙出跟进草稿（甲有回音、乙重发不满 7 天）；
 *     再扫不重复；点「不跟了」→ 以后再扫也不出。
 *  ④ 另起一份丁：跟进草稿待审时丁来了回信 → 那封跟进被系统作废。
 *  ⑤ 甲同域名另一个地址发来面试安排 → 挂回甲、到面试、有期限；
 *  ⑥ noreply@mokahr.com「【丙智能】笔试通知」→ 挂到丙、归为笔试、有期限与等你那件、往来带种类、不起草回信；
 *  ⑦ 公共邮箱域名的陌生人来信 → 不因域名挂到任何申请。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MailAccount } from '@career/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isMailDraftView, isMailThreadView, type MailDraftView } from '../../shared/careerMailApply';
import { handleCareerRoute } from '../routes/career';
import { applyJobs } from './batch-apply';
import { loadCore } from './core-module';
import { asksFor } from './delivery';
import { setMailCredentialsPath, setMailPassword } from './mail/credentials';
import { executeApprovedSendMails, type SendMailPayload } from './mail/send';
import { archiveBatch, type FetchedMail } from './mail/sync';
import { draftMailForAction } from './mail-apply/drafter';
import { runFollowupSweep } from './mail-apply/followup';
import { parseSendMailPayload } from './mail-apply/payload';
import { MailDrafter } from './mail-apply/runner';
import { internJd, mailFixture, modelMail, PERSON, type MailFixture } from './mail-apply/test-fixture';

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

const core = await loadCore();
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-02T02:00:00.000Z');
const day = (n: number) => vi.setSystemTime(new Date(T0 + n * DAY));
const DOMAINS: Record<string, string> = { 甲科技: 'jia', 乙数据: 'yi', 丙智能: 'bing', 丁网络: 'ding' };

describe('链路 · 邮件投递（发出之后）', () => {
  let dir: string;
  let f: MailFixture;
  let account: MailAccount;
  const sent: SendMailPayload[] = [];
  let uid = 100;

  const route = async (method: string, path: string, body?: unknown) => {
    const res = await handleCareerRoute(path.split('?')[0], new Request(`http://local${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }),
      { repos: f.repos, vault: f.vault, llm: null, broadcast: () => undefined, exportsDir: dir, studioExport: false });
    return (await res!.json()) as Record<string, unknown>;
  };
  const drafts = (v: unknown): MailDraftView[] => (Array.isArray(v) ? v.filter(isMailDraftView) : []);
  const preview = async (id: string) => drafts((await route('GET', `/api/career/mail-apply/drafts?ids=${id}`)).drafts)[0];
  const drain = () => new MailDrafter({ repos: f.repos, draft: a => draftMailForAction(f.deps, a) }).drain();
  const send = (ids: string[]) => {
    f.repos.reviewActions(ids, 'approved', 'user');
    return executeApprovedSendMails({ repos: f.repos, core, llm: null, broadcast: () => undefined, sessionId: () => 'global', vault: f.vault,
      transport: async (_a, _p, m) => { sent.push(m); return { messageId: `<m${sent.length}@qq.com>` }; } }, ids);
  };
  /** 收一批信（增量同步，不是第一次连邮箱的历史导入）。 */
  const receive = (...mails: Array<Partial<FetchedMail> & Pick<FetchedMail, 'from' | 'subject' | 'text'>>) =>
    archiveBatch({ repos: f.repos, core, llm: f.llm, broadcast: () => undefined, sessionId: () => 'global' }, account,
      mails.map(m => ({ uid: ++uid, message_id: `<in${uid}@x>`, in_reply_to: null, to: 'me@qq.com', received_at: new Date().toISOString(), ...m })), false);
  const appOf = (company: string) => f.repos.applicationsWithJob().find(a => a.job.company_name === company)!;
  const pendingFor = (company: string) => f.repos.listActions('pending_review').filter(a => a.kind === 'send_mail' && a.application_id === appOf(company).id);
  const appliedRows = () => f.repos.db.all<{ application_id: string }>(`SELECT application_id FROM application_history WHERE to_stage='applied' AND substr(created_at,1,7)='2026-11'`).length;

  /** 开始投、写好、填到岗信息、发出：返回发出的那封 send_mail 的 id。 */
  async function applyAndSend(companies: string[]): Promise<void> {
    for (const c of companies) f.repos.upsertJob({ source_platform: 'manual', source_job_id: c, title: '产品实习生', company_name: c, jd_raw: internJd(c, DOMAINS[c]) });
    await applyJobs(f.deps, f.repos.listJobs().filter(j => companies.includes(j.company_name ?? '')).map(j => j.id));
    for (const _ of companies) f.llm.push(modelMail());
    await drain();
    const ids = companies.flatMap(c => pendingFor(c).map(a => a.id));
    expect(ids).toHaveLength(companies.length);
    const results = await send(ids);
    expect(results.every(r => r.ok && !r.skipped)).toBe(true);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    day(0);
    dir = mkdtempSync(join(tmpdir(), 'career-mail-after-'));
    setMailCredentialsPath(join(dir, 'creds.json'));
    f = await mailFixture(dir);
    account = f.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: { name: '{{vault:profile.name}}' } } });
    for (const [field, value] of [['internDaysPerWeek', '4'], ['internMonths', '6'], ['availableDate', '随时']]) f.vault.set({ scope: 'profile', field, value, sensitive: false });
    sent.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('回信认回、退信出声、自动回复只当确认、一周没回音写好跟进、来信撤回跟进', async () => {
    await applyAndSend(['甲科技', '乙数据', '丙智能']);
    expect(sent).toHaveLength(3);
    expect(appliedRows()).toBe(3);
    const sentTo = (domain: string) => sent.findIndex(m => m.to === `hr@${domain}.com`);
    const original = (domain: string) => `<m${sentTo(domain) + 1}@qq.com>`;

    // ① 第 1 天：甲的 HR 另起主题直接回信问到岗时间（引用的原信里有他的手机号）
    day(1);
    const calls = f.llm.calls.length;
    f.llm.push(JSON.stringify({ kind: 'other', relevance: 'job', needs_reply: true, fields: { company: '甲科技' }, summary: 'HR 问到岗时间' }));
    f.llm.push(req => {
      const prompt = req.messages[0].content;
      expect(req.system).toContain('mail-reply');
      expect(prompt).toContain('模式：回信');
      expect(prompt).toContain('每周可实习：4 天');
      expect(prompt).toContain('最早到岗：随时');
      expect(prompt).not.toContain(PERSON.phone);
      return JSON.stringify({ body: '王老师您好！我每周可以实习4天，可以连续实习6个月，随时可以到岗。' });
    });
    await receive({ from: '王老师 <HR@jia.com>', subject: '关于实习时间', text: `同学你好，想确认一下你最早什么时候能到岗？\n\n> ${PERSON.name} ${PERSON.phone}` });
    await drain();
    expect(f.llm.calls.length - calls).toBe(2);
    const jia = appOf('甲科技');
    const inMail = f.repos.listMailMessages({ application_id: jia.id, direction: 'in' });
    expect(inMail).toHaveLength(1);
    const replyAsk = asksFor(f.repos).find(a => a.mail?.purpose === 'reply')!;
    expect(replyAsk).toMatchObject({ kind: 'review', title: '甲科技 回信了', application_ids: [jia.id] });
    const reply = await preview(replyAsk.mail!.action_ids[0]);
    expect(reply.incoming).toMatchObject({ from: '王老师 <HR@jia.com>', text: expect.stringContaining('最早什么时候能到岗') });
    expect(reply.thread?.subject).toBe('关于实习时间');
    expect(reply).toMatchObject({ purpose: 'reply', to: 'hr@jia.com', subject: 'Re: 关于实习时间', attachments: [], blockers: [] });
    expect(reply.body).toContain('我每周可以实习4天，可以连续实习6个月，随时可以到岗。');
    expect(reply.body).not.toContain('【待补');
    expect(reply.body).toContain(PERSON.name);
    // 回信默认不带附件，但照样能换上一份简历（附上简历）：用代码的默认附件名
    expect(reply.resume_options.length).toBeGreaterThan(0);
    const withResume = (await route('POST', `/api/career/mail-apply/drafts/${reply.action_id}`, { resume_id: reply.resume_options[0].id })).draft;
    expect(isMailDraftView(withResume) && withResume.attachments.map(a => a.filename)).toEqual([`${PERSON.school}-${PERSON.name}-${PERSON.major}-2027届.pdf`]);
    await send([reply.action_id]);
    const out = sent.at(-1)!;
    expect(out).toMatchObject({ to: 'hr@jia.com', in_reply_to: inMail[0].message_id, references: [inMail[0].message_id] });
    expect(f.repos.getApplication(jia.id)!.stage).toBe('applied');
    expect(f.repos.listMailMessages({ application_id: jia.id, direction: 'out' })[0].in_reply_to).toBe(inMail[0].message_id);
    const thread = (await route('GET', `/api/career/mail-apply/thread?application_id=${jia.id}`)).thread;
    expect(isMailThreadView(thread) && thread.items.map(i => [i.direction, i.purpose])).toEqual([['out', 'apply'], ['in', null], ['out', 'reply']]);

    // ② 第 2 天：乙退信 → 撤回投出、出「邮件被退回」，收件人不改不能发
    day(2);
    const yi = appOf('乙数据');
    const llmBefore = f.llm.calls.length;
    const bounce = { from: 'MAILER-DAEMON@qq.com', subject: '系统退信', text: '很抱歉您的邮件无法送达。\n收件人：hr@yi.com\n原因：用户不存在' };
    await receive(bounce);
    expect(f.llm.calls.length).toBe(llmBefore);
    expect(f.repos.getApplication(yi.id)!.stage).not.toBe('applied');
    expect(appliedRows()).toBe(2);
    expect(f.repos.listDossierNotes(yi.id).some(n => n.content.includes('投递邮件被退回'))).toBe(true);
    const bouncedAsk = asksFor(f.repos).find(a => a.mail?.bounced)!;
    expect(bouncedAsk).toMatchObject({ title: '乙数据 · 邮件被退回', application_ids: [yi.id], mail: { purpose: 'apply', bounced: true } });
    const resend = await preview(bouncedAsk.mail!.action_ids[0]);
    expect(resend.to).toBe('hr@yi.com');
    expect(resend.blockers).toEqual(['bad_recipient']);
    // 同一封退信又来一次（另一封通知）：不重复排
    await receive({ ...bounce, subject: 'Undelivered Mail Returned to Sender' });
    expect(pendingFor('乙数据')).toHaveLength(1);
    const fixed = (await route('POST', `/api/career/mail-apply/drafts/${resend.action_id}`, { to: 'campus@yi.com' })).draft;
    expect(isMailDraftView(fixed) && fixed.blockers).toEqual([]);
    const [resent] = await send([resend.action_id]);
    expect(resent).toMatchObject({ ok: true });
    expect(sent.at(-1)!.to).toBe('campus@yi.com');
    expect(f.repos.getApplication(yi.id)!.stage).toBe('applied');
    expect(f.repos.getJob(yi.job_id)!.apply_email).toBe('campus@yi.com');
    expect(appliedRows()).toBe(3);

    // ③ 第 3 天：丙自动回复 → 确认信、阶段不动、不调模型
    day(3);
    const bing = appOf('丙智能');
    const llmAuto = f.llm.calls.length;
    await receive({ from: 'hr@bing.com', subject: '自动回复：应聘【产品实习生】', text: '您好，已收到您的邮件，我们会尽快处理。' });
    expect(f.llm.calls.length).toBe(llmAuto);
    expect(f.repos.listMailMessages({ application_id: bing.id, direction: 'in' })[0].kind).toBe('application_received');
    expect(f.repos.getApplication(bing.id)!.stage).toBe('applied');
    expect(asksFor(f.repos).some(a => a.mail?.purpose === 'reply')).toBe(false);

    // 第 8 天扫一次：只有丙（甲有回音、乙第 2 天重发不满 7 天）
    day(8);
    const queued = runFollowupSweep(f.repos, new Date().toISOString());
    expect(queued.map(id => f.repos.getAction(id)!.application_id)).toEqual([bing.id]);
    expect(runFollowupSweep(f.repos, new Date().toISOString())).toEqual([]);
    f.llm.push(req => { expect(req.messages[0].content).toContain('模式：跟进'); return JSON.stringify({ body: '您好！上周我投递了贵司产品实习生岗位，做过三次竞品调研，想了解一下目前的进展。' }); });
    await drain();
    const followAsk = asksFor(f.repos).find(a => a.mail?.purpose === 'followup')!;
    expect(followAsk).toMatchObject({ title: '丙智能 · 再争取一下', detail: '投出一周没回音', application_ids: [bing.id] });
    const follow = await preview(followAsk.mail!.action_ids[0]);
    expect(follow).toMatchObject({ purpose: 'followup', to: 'hr@bing.com', blockers: [], incoming: null });
    expect(follow.subject.startsWith('Re: 应聘【产品实习生】')).toBe(true);
    expect(follow.attachments).toHaveLength(1);
    // 往来接口里待发的那封是 pending（带用途和动作 id，前端拿它去取预览）
    const bingThread = (await route('GET', `/api/career/mail-apply/thread?application_id=${bing.id}`)).thread;
    expect(isMailThreadView(bingThread) && bingThread.items.map(i => [i.direction, i.purpose, i.action_id])).toEqual([['out', 'apply', null], ['in', null, null], ['pending', 'followup', follow.action_id]]);
    expect(parseSendMailPayload(follow.action_id, f.repos.getAction(follow.action_id)!.payload_json).in_reply_to).toBe(original('bing'));
    // 「不跟了」= rejected、不 drop；以后再扫也不出
    await route('POST', '/api/career/actions/review', { ids: [follow.action_id], decision: 'rejected' });
    expect(f.repos.getAction(follow.action_id)!.status).toBe('rejected');
    expect(f.repos.getApplication(bing.id)!.stage).toBe('applied');
    day(30);
    // 第 30 天：乙重发也满一周了，轮到乙；丙已经说过不跟了，不再出
    expect(runFollowupSweep(f.repos, new Date().toISOString()).map(id => f.repos.getAction(id)!.application_id)).toEqual([yi.id]);
    f.llm.push(JSON.stringify({ body: '您好！想了解一下产品实习生岗位目前的进展。' }));
    await drain();

    // ④ 丁：跟进草稿待审时丁来了回信 → 那封跟进被系统作废
    day(31);
    await applyAndSend(['丁网络']);
    const ding = appOf('丁网络');
    day(39);
    const dingFollow = runFollowupSweep(f.repos, new Date().toISOString()).filter(id => f.repos.getAction(id)!.application_id === ding.id);
    expect(dingFollow).toHaveLength(1);
    f.llm.push(JSON.stringify({ body: '您好！想了解一下产品实习生岗位目前的进展。' }));
    await drain();
    const pendingFollow = pendingFor('丁网络');
    expect(pendingFollow).toHaveLength(1);
    // 乙（第 30 天那封）和丁的跟进合成一件（第三轮 R3：几十份同时到期不刷屏）
    const merged = asksFor(f.repos).filter(a => a.mail?.purpose === 'followup');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ title: '2 家可以再争取一下', detail: '投出一周没回音' });
    expect(merged[0].application_ids.sort()).toEqual([yi.id, ding.id].sort());
    f.llm.push(JSON.stringify({ kind: 'other', relevance: 'job', needs_reply: false, fields: { company: '丁网络' }, summary: '简历已转给业务部门' }));
    await receive({ from: 'hr@ding.com', subject: '简历已转给业务部门', text: '同学你好，简历已转给业务部门，有消息会通知你。' });
    expect(f.repos.getAction(pendingFollow[0].id)).toMatchObject({ status: 'rejected' });
    expect(JSON.parse(f.repos.getAction(pendingFollow[0].id)!.result_json!)).toMatchObject({ by: 'system' });
    expect(asksFor(f.repos).some(a => a.mail?.purpose === 'followup' && a.application_ids.includes(ding.id))).toBe(false);

    // ⑤ 同公司另一个地址（同域名、另起主题、没有 In-Reply-To）发来面试安排 → 挂回甲、到面试、有期限
    day(40);
    const interviewAt = new Date(T0 + 45 * DAY).toISOString();
    f.llm.push(JSON.stringify({ kind: 'interview_invite', relevance: 'job', needs_reply: false, fields: { company: '甲科技', title: '产品实习生', when: interviewAt }, summary: '一面安排' }));
    await receive({ from: '业务面试官 <interview@jia.com>', subject: '面试安排', text: '同学你好，邀请你参加一面，时间见下。' });
    const interviewMail = f.repos.listMailMessages({ direction: 'in' }).find(m => m.subject === '面试安排')!;
    expect(interviewMail).toMatchObject({ application_id: jia.id, kind: 'interview_invite' });
    expect(f.repos.getApplication(jia.id)!.stage).toBe('interview');
    expect(f.repos.listDeadlines({ application_id: jia.id }).some(d => d.kind === 'interview')).toBe(true);

    // ⑥ 招聘系统代发（noreply@mokahr.com）「【丙智能】笔试通知」→ 按公司挂到丙、归为笔试、建期限、等你条有那件、往来带种类；不起草回信
    const testDue = new Date(T0 + 43 * DAY).toISOString();
    f.llm.push(JSON.stringify({ kind: 'written_test', relevance: 'job', needs_reply: true, fields: { company: '丙智能', title: '产品实习生', due_at: testDue }, summary: '丙智能笔试' }));
    await receive({ from: '丙智能校园招聘 <noreply@mokahr.com>', subject: '【丙智能】笔试通知', text: '请于截止前完成在线笔试。此邮件由系统自动发送，请勿回复。' });
    const testMail = f.repos.listMailMessages({ direction: 'in' }).find(m => m.subject === '【丙智能】笔试通知')!;
    expect(testMail).toMatchObject({ application_id: bing.id, kind: 'written_test' });
    expect(f.repos.listDeadlines({ application_id: bing.id }).some(d => d.kind === 'written_test')).toBe(true);
    expect(asksFor(f.repos).some(a => a.application_ids.includes(bing.id) && a.kind === 'deadline')).toBe(true);
    const bingItems = (await route('GET', `/api/career/mail-apply/thread?application_id=${bing.id}`)).thread;
    expect(isMailThreadView(bingItems) && bingItems.items.find(i => i.subject === '【丙智能】笔试通知')?.kind).toBe('written_test');
    expect(f.repos.listActions().some(a => a.kind === 'draft_mail' && a.application_id === bing.id && JSON.parse(a.payload_json).purpose === 'reply')).toBe(false);

    // ⑦ 公共邮箱域名、和任何已发收件人都不同的人发来不相干的信 → 不会因为域名被挂到任何申请
    const llmCalls = f.llm.calls.length;
    await receive({ from: '张同学 <zhang@qq.com>', subject: '周末一起吃饭吗', text: '好久不见，周末有空吗？' });
    expect(f.repos.listMailMessages({ direction: 'in' }).find(m => m.subject === '周末一起吃饭吗')?.application_id ?? null).toBeNull();
    expect(f.llm.calls.length).toBe(llmCalls);
  });
});
