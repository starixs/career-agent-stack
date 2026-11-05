/**
 * 链路切面「邮件投递」（face-mail-apply 2026-11-05）：邮件和网申同构——同一个入口开始、后台写、等你里过目、点发出才发。
 *
 * 库里 5 个岗位（2 个网申、3 个 JD 里写了投递邮箱的实习）→ applyJobs 全选 → 2 个 fill_form、3 个 draft_mail →
 * 起草器跑完 → 等你条一件「3 封邮件写好了」→ 预览 3 封都带收件人 / 标题 / 正文 / 附件、缺到岗信息 →
 * 存到岗信息 → 不差东西了、标题带每周天数 → 改其中一封正文 → 全部批准 → 发出去的 3 封与预览一致 →
 * 3 份申请都已投出（证据 mail:）→ 再投同样 5 个：邮件那 3 个「已经投过」。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isMailDraftView, isMailFileOption, isMailThreadView, MAIL_TRUST_KEY, type MailDraftView } from '../../shared/careerMailApply';
import { handleCareerRoute } from '../routes/career';
import { applyJobs } from './batch-apply';
import { loadCore } from './core-module';
import { proposeBatch, startDoneLine } from './batch-propose';
import { asksFor, buildRun } from './delivery';
import { setMailCredentialsPath, setMailPassword } from './mail/credentials';
import { executeApprovedSendMails, executeSendMailAction, type SendMailPayload } from './mail/send';
import { setAutoMode } from './submit-policy';
import { setTargetJob } from './targets';
import { delegate, readLedger, shouldProposeDelegate, trustOf } from './trust-ledger';
import { draftMailForAction } from './mail-apply/drafter';
import { MailDrafter } from './mail-apply/runner';
import { railSnapshot } from './rail';
import { internJd, mailFixture, modelMail, PERSON, type MailFixture } from './mail-apply/test-fixture';

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

const core = await loadCore();
const MAIL_DOMAINS: Record<string, string> = { 甲科技: 'jia', 乙数据: 'yi', 丙智能: 'bing' };
const MAIL_COMPANIES = Object.keys(MAIL_DOMAINS);
const WEB_COMPANIES = ['丁网络', '戊软件'];

describe('链路 · 邮件投递（投出之前）', () => {
  let dir: string;
  let f: MailFixture;
  const route = async (method: string, path: string, body?: unknown) => {
    const res = await handleCareerRoute(path.split('?')[0], new Request(`http://local${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) }),
      { repos: f.repos, vault: f.vault, llm: null, broadcast: () => undefined, exportsDir: dir, studioExport: false });
    return (await res!.json()) as Record<string, unknown>;
  };
  const drafts = (v: unknown): MailDraftView[] => (Array.isArray(v) ? v.filter(isMailDraftView) : []);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'career-mail-slice-'));
    setMailCredentialsPath(join(dir, 'creds.json'));
    f = await mailFixture(dir);
    const account = f.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: { name: '{{vault:profile.name}}' } } });
    for (const c of MAIL_COMPANIES) f.repos.upsertJob({ source_platform: 'manual', source_job_id: c, title: '产品实习生', company_name: c, jd_raw: internJd(c, MAIL_DOMAINS[c]) });
    for (const c of WEB_COMPANIES) f.repos.upsertJob({ source_platform: 'campus', source_job_id: c, title: '后端开发', company_name: c, url: `https://jobs.${c}.test/apply` });
  });
  afterEach(() => { delete process.env.CAREER_DATA_DIR; setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('从开始投到发出，邮件和网申同一条路', async () => {
    const ids = f.repos.listJobs().map(j => j.id);
    const mailJobs = f.repos.listJobs().filter(j => MAIL_COMPANIES.includes(j.company_name ?? ''));
    expect(mailJobs.map(j => j.employment_type)).toEqual(['intern', 'intern', 'intern']);

    // 0. 今天这批的勾选表：只收邮件的岗位照样进表，系统一栏写「邮件」，不说「新系统 · 先停给你看」
    const table = proposeBatch(f.repos, f.store, { pick: 'all' });
    expect(table.rows).toHaveLength(5);
    for (const r of table.rows.filter(x => MAIL_COMPANIES.includes(x.company))) expect(r).toMatchObject({ channel: 'mail', system: '邮件', known: true, delegated: false });
    for (const r of table.rows.filter(x => WEB_COMPANIES.includes(x.company))) expect(r.channel).toBe('web');

    // 1. 一次开始：网申两家排填表，邮件三家排写邮件；没有一家因为「没有网申链接」被跳过
    const res = await applyJobs(f.deps, ids);
    const started = res.started.map(id => f.repos.getAction(id)!);
    expect(started.filter(a => a.kind === 'fill_form')).toHaveLength(2);
    expect(started.filter(a => a.kind === 'draft_mail')).toHaveLength(3);
    expect(started.every(a => a.status === 'approved')).toBe(true);
    expect(res.mails).toBe(3);
    expect(res.skipped).toEqual([]);

    expect(startDoneLine(res.started.length, res.skipped, res.mails)).toBe('已开始投 5 家 · 其中 3 封邮件在写');
    // 在写的邮件算「在做」：右栏、今天的数、批次卡都看得到
    expect(railSnapshot(f.repos, f.store, core).blocks.find(b => b.id === 'apply')?.line).toBe('在写 3 封投递邮件');
    expect(proposeBatch(f.repos, f.store).today.filling).toBe(5);
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(buildRun(f.repos, { since })?.total).toBe(5);

    // 2. 起草器跑完：每封定制了简历、调了一次模型，排出一封等过目的 send_mail
    for (let i = 0; i < 3; i++) f.llm.push(modelMail());
    await new MailDrafter({ repos: f.repos, draft: a => draftMailForAction(f.deps, a) }).drain();
    expect(f.llm.calls).toHaveLength(3);
    expect(f.tailorCalls.sort()).toEqual(mailJobs.map(j => j.id).sort());
    expect(f.repos.listActions().filter(a => a.kind === 'draft_mail').map(a => a.status)).toEqual(['done', 'done', 'done']);
    const sends = f.repos.listActions('pending_review').filter(a => a.kind === 'send_mail');
    expect(sends).toHaveLength(3);

    // 写好待发的算「等你」：右栏备好 3 份
    const rail = railSnapshot(f.repos, f.store, core);
    expect(rail.today.prepared).toBe(3);
    expect(rail.blocks.find(b => b.id === 'apply')?.line).toBe('3 封邮件写好了，等你过目');

    // 3. 等你条：一件「3 封邮件写好了」，只带动作 id，不带邮件内容
    const mailAsks = asksFor(f.repos).filter(a => a.mail);
    expect(mailAsks).toHaveLength(1);
    expect(mailAsks[0]).toMatchObject({ kind: 'review', title: '3 封邮件写好了', mail: { purpose: 'apply' } });
    expect([...mailAsks[0].mail!.action_ids].sort()).toEqual(sends.map(a => a.id).sort());
    expect(JSON.stringify(mailAsks[0])).not.toContain('@');
    // 往来接口：还没发出的那封投递邮件是 pending 项（带用途和动作 id，进展页拿它取预览）
    const firstThread = (await route('GET', `/api/career/mail-apply/thread?application_id=${sends[0].application_id}`)).thread;
    expect(isMailThreadView(firstThread) && firstThread.items.map(i => [i.direction, i.purpose, i.action_id])).toEqual([['pending', 'apply', sends[0].id]]);

    // 4. 预览：3 封都有收件人、标题、正文、附件；占位符已在本机解开；实习岗位还缺到岗信息
    const query = `/api/career/mail-apply/drafts?ids=${sends.map(a => a.id).join(',')}`;
    let views = drafts((await route('GET', query)).drafts);
    expect(views).toHaveLength(3);
    for (const v of views) {
      expect(v.to).toBe(`hr@${MAIL_DOMAINS[v.company]}.com`);
      expect(v.subject).toContain(`应聘【产品实习生】-${PERSON.school}-${PERSON.name}`);
      expect(v.body).toContain(PERSON.phone);
      expect(v.body).not.toContain('{{vault:');
      expect(v.attachments).toHaveLength(1);
      expect(v.attachments[0].filename).toBe(`${PERSON.school}-${PERSON.name}-${PERSON.major}-2027届.pdf`);
      expect(v.attachments[0].tailored_changes).toBe(2);
      expect(v.blockers).toEqual(['availability']);
      expect(v.availability).toEqual({ days_per_week: null, months: null, start: null });
    }

    // 5. 存到岗信息：不差东西了，标题带每周天数，到岗那句换成完整的（不调模型）
    const after = drafts((await route('POST', '/api/career/mail-apply/availability', { days_per_week: '4', months: '6', start: '随时' })).drafts);
    expect(after).toHaveLength(3);
    for (const v of after) {
      expect(v.blockers).toEqual([]);
      expect(v.subject).toContain('每周4天');
      expect(v.subject).toContain('可实习6个月');
      expect(v.body).toContain('我每周可实习4天，可连续实习6个月，随时可以到岗。简历见附件，期待您的回复。');
    }
    expect(f.llm.calls).toHaveLength(3);

    // 6. 改其中一封的正文（他写了自己的名字和电话：存回去是占位符，看到的仍是明文）
    const edited = after[1];
    const newBody = `${edited.body}\n\n补一句：作品集我可以面试时带上。${PERSON.name}`;
    const patched = (await route('POST', `/api/career/mail-apply/drafts/${edited.action_id}`, { body: newBody })).draft;
    expect(isMailDraftView(patched) && patched.body).toBe(newBody);
    const stored = f.repos.getAction(edited.action_id)!.payload_json;
    expect(stored).not.toContain(PERSON.name);
    expect(stored).not.toContain(PERSON.phone);
    views = drafts((await route('GET', query)).drafts);
    for (const v of views) expect(v).toMatchObject({ file_options: [], wanted: [], portfolio: { url: null, included: false } });

    // 6b. 存一个作品集文件、顺手附到第一封上 → 那封带两个附件；其余几封的可选里都有它（存一次，以后每封都能点一下附上）
    process.env.CAREER_DATA_DIR = dir;
    const first = views[0];
    const up = await route('POST', '/api/career/mail-apply/files', { name: '作品集.pdf', base64: Buffer.from('%PDF portfolio').toString('base64'), label: '作品集', action_id: first.action_id });
    expect(isMailFileOption(up.file) && up.file.label).toBe('作品集');
    expect(isMailDraftView(up.draft) && up.draft.attachments.map(a => [a.kind, a.filename])).toEqual([['resume', first.attachments[0].filename], ['file', '作品集.pdf']]);
    views = drafts((await route('GET', query)).drafts);
    for (const v of views) expect(v.file_options).toEqual(v.action_id === first.action_id ? [] : [up.file]);
    // 不合格的说人话（前端原样显示在附件行下面）
    expect(await route('POST', '/api/career/mail-apply/files', { name: 'run.exe', base64: Buffer.from('x').toString('base64') })).toMatchObject({ ok: false, error: '这种文件发不了，换成 PDF、Word、PPT、图片或压缩包' });
    expect(await route('POST', `/api/career/mail-apply/drafts/${first.action_id}`, { portfolio_url: 'not a url' })).toMatchObject({ ok: false, error: '这不像一个网址' });

    // 7. 全部批准 → 发出去的 3 封与预览一模一样（含改过的那封）
    const sent: SendMailPayload[] = [];
    f.repos.reviewActions(sends.map(a => a.id), 'approved', 'user');
    const results = await executeApprovedSendMails({ repos: f.repos, core, llm: null, broadcast: () => undefined, sessionId: () => 'global', vault: f.vault, transport: async (_a, _p, m) => { sent.push(m); return { messageId: `<m${sent.length}@x>` }; } }, sends.map(a => a.id));
    expect(results.every(r => r.ok)).toBe(true);
    expect(sent).toHaveLength(3);
    const shape = (m: { to: string; subject: string; body: string; attachments?: Array<{ filename?: string }> }) => ({ to: m.to, subject: m.subject, body: m.body, files: (m.attachments ?? []).map(a => a.filename) });
    const byTo = (xs: Array<ReturnType<typeof shape>>) => [...xs].sort((a, b) => a.to.localeCompare(b.to));
    expect(byTo(sent.map(shape))).toEqual(byTo(views.map(v => shape({ ...v, attachments: v.attachments }))));
    expect(sent.find(m => m.to === edited.to)?.body).toBe(newBody);
    expect(sent.find(m => m.to === first.to)?.attachments?.map(a => a.filename)).toEqual([first.attachments[0].filename, '作品集.pdf']);

    // 8. 3 份申请都已投出，证据指向发出的邮件
    for (const j of mailJobs) {
      const app = f.repos.listApplications().find(a => a.job_id === j.id)!;
      expect(app.stage).toBe('applied');
      expect(app.submission_evidence).toMatch(/^mail:/);
    }

    // 9. 再投同样 5 个：邮件那 3 个已经投过，网申两个还在投
    const again = await applyJobs(f.deps, ids);
    expect(again.started).toEqual([]);
    const reasonOf = (c: string) => again.skipped.find(s => s.job_id === f.repos.listJobs().find(j => j.company_name === c)!.id)?.reason;
    for (const c of MAIL_COMPANIES) expect(reasonOf(c)).toBe('已经投过');
    for (const c of WEB_COMPANIES) expect(reasonOf(c)).toBe('已在投');
  });

  it('放权（第三轮 R2）：总开关开着写好且不差东西的直接发出、标星的留给他看；盖章后同样直接发；有 blocker 时即使放权也停下', async () => {
    const sent: SendMailPayload[] = [];
    const sendDeps = { repos: f.repos, core, llm: null, broadcast: () => undefined, sessionId: () => 'global', vault: f.vault, transport: async (_a: unknown, _p: string, m: SendMailPayload) => { sent.push(m); return { messageId: `<a${sent.length}@x>` }; } };
    const deps = { ...f.deps, sendNow: async (id: string) => executeSendMailAction(sendDeps, f.repos.getAction(id)!) };
    const drain = () => new MailDrafter({ repos: f.repos, draft: a => draftMailForAction(deps, a) }).drain();
    const jobOf = (c: string) => f.repos.listJobs().find(j => j.company_name === c)!;
    const appOf = (c: string) => f.repos.listApplications().find(a => a.job_id === jobOf(c).id)!;
    const sendOf = (c: string) => f.repos.listActions().find(a => a.kind === 'send_mail' && a.application_id === appOf(c).id)!;
    for (const [field, value] of [['internDaysPerWeek', '4'], ['internMonths', '6'], ['availableDate', '随时']]) f.vault.set({ scope: 'profile', field, value, sensitive: false });
    const since = new Date(Date.now() - 60_000).toISOString();

    // 1. 开总开关、标星甲科技 → 投 3 个邮件岗位 → 乙、丙直接发出（批准人 auto），甲留给他看
    setAutoMode(f.repos, true);
    setTargetJob(f.repos, jobOf('甲科技').id, true);
    await applyJobs(f.deps, MAIL_COMPANIES.map(c => jobOf(c).id));
    for (let i = 0; i < 3; i++) f.llm.push(modelMail());
    await drain();
    expect(sent.map(m => m.to).sort()).toEqual(['hr@bing.com', 'hr@yi.com']);
    for (const c of ['乙数据', '丙智能']) {
      expect(sendOf(c)).toMatchObject({ status: 'done', approved_by: 'auto' });
      expect(appOf(c).stage).toBe('applied');
    }
    expect(sendOf('甲科技')).toMatchObject({ status: 'pending_review' });
    const mailAsks = asksFor(f.repos).filter(a => a.mail);
    expect(mailAsks.map(a => a.title)).toEqual(['甲科技 · 邮件写好了']);
    // 计数：直接发出的不经过「等你」直接算已投出
    const run = buildRun(f.repos, { since })!;
    expect(run.items.filter(i => i.state === 'done').map(i => i.company.name).sort()).toEqual(['丙智能', '乙数据']);
    expect(railSnapshot(f.repos, f.store, core).today.prepared).toBe(1);
    // 做通两封：信任账本里「邮件投递」这一类到了提议放权的时候（他点了才放）
    expect(shouldProposeDelegate(readLedger(f.repos)[MAIL_TRUST_KEY])).toBe(true);
    expect(trustOf(f.repos, MAIL_TRUST_KEY)).toBe('shown');

    // 2. 关总开关、给邮件类盖章 → 再投 1 个 → 直接发出，批准人 delegated
    setAutoMode(f.repos, false);
    expect(delegate(f.repos, MAIL_TRUST_KEY)?.state).toBe('delegated');
    f.repos.upsertJob({ source_platform: 'manual', source_job_id: '庚', title: '产品实习生', company_name: '庚教育', jd_raw: internJd('庚教育', 'geng') });
    await applyJobs(f.deps, [jobOf('庚教育').id]);
    f.llm.push(modelMail());
    await drain();
    expect(sendOf('庚教育')).toMatchObject({ status: 'done', approved_by: 'delegated' });
    expect(sent.at(-1)!.to).toBe('hr@geng.com');

    // 3. 到岗信息没了（blocker）：放权也停下
    f.repos.db.run(`DELETE FROM vault_item WHERE field='internDaysPerWeek'`);
    f.repos.upsertJob({ source_platform: 'manual', source_job_id: '辛', title: '产品实习生', company_name: '辛医疗', jd_raw: internJd('辛医疗', 'xin') });
    await applyJobs(f.deps, [jobOf('辛医疗').id]);
    f.llm.push(modelMail());
    await drain();
    expect(sendOf('辛医疗')).toMatchObject({ status: 'pending_review', approved_by: null });
    expect(sent).toHaveLength(3);
  });
});
