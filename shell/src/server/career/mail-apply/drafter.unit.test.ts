/**
 * 后台写投递邮件（draft_mail → send_mail）：注入假模型与假定制器。
 * 到岗那句、署名、默认标题、附件名由代码拼；模型只写前两段（JD 指定格式时也写标题 / 附件名）；
 * 超时 / 出错重试一次，仍不成记「没写成」；没连邮箱不算失败；起草器重启后把写到一半的放回队列；永远不发信。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyJobs, planJobs } from '../batch-apply';
import { draftMailForAction } from './drafter';
import { parseSendMailPayload } from './payload';
import { MailDrafter } from './runner';
import { internJd, mailFixture, modelMail, type MailFixture } from './test-fixture';

describe('邮件起草器', () => {
  let dir: string;
  let f: MailFixture;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'career-mail-draft-'));
    f = await mailFixture(dir);
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** 一个邮件岗位开始投，返回它的 draft_mail。 */
  async function startOne(jd = internJd('甲科技', 'jia'), title = '产品实习生') {
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: title + jd.length, title, company_name: '甲科技', jd_raw: jd });
    const res = await applyJobs(f.deps, [job.id], null, { notes: '提一下我会 SQL' });
    expect(res.mails).toBe(1);
    return { job, draft: f.repos.getAction(res.started[0])! };
  }
  const sendOf = () => f.repos.listActions().find(a => a.kind === 'send_mail')!;

  it('默认格式：标题与到岗那句由代码拼，署名用占位符；模型只写前两段；他的要求进了提示词', async () => {
    const { draft } = await startOne();
    f.llm.push(req => { expect(req.messages[0].content).toContain('模式：邮件投递'); expect(req.messages[0].content).toContain('提一下我会 SQL'); expect(req.messages[0].content).not.toContain('张三'); return modelMail(); });
    expect(await draftMailForAction(f.deps, draft)).toBe('drafted');
    const send = sendOf();
    expect(send.status).toBe('pending_review');
    const p = parseSendMailPayload(send.id, send.payload_json);
    expect(p).toMatchObject({ purpose: 'apply', subject_auto: true, to: 'hr@jia.com', draft_action_id: draft.id, arrival_line: '简历见附件，期待您的回复。' });
    expect(p.subject).toBe('应聘【产品实习生】-华东大学-{{vault:profile.name}}');
    expect(p.body.endsWith('简历见附件，期待您的回复。\n\n{{vault:profile.name}}\n华东大学\n{{vault:profile.phone}}')).toBe(true);
    expect(p.attachments?.[0].filename).toBe('华东大学-{{vault:profile.name}}-计算机科学-2027届.pdf');
    expect(p.attachments?.[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.repos.getAction(draft.id)).toMatchObject({ status: 'done' });
    expect(JSON.parse(f.repos.getAction(draft.id)!.result_json!)).toEqual({ send_action_id: send.id });
    expect(f.repos.listMailMessages({ direction: 'out' })).toHaveLength(0);
  });

  it('JD 指定了标题与附件格式：用模型按格式填的，subject_auto=false；附件名不合格退回默认', async () => {
    const { draft } = await startOne(internJd('甲科技', 'jia', '邮件标题：姓名-学校-岗位。附件命名：姓名-学校.pdf'));
    f.llm.push(modelMail({ subject: '{{vault:profile.name}}-华东大学-产品实习生', attachment: '../简历.pdf' }));
    await draftMailForAction(f.deps, draft);
    const p = parseSendMailPayload(sendOf().id, sendOf().payload_json);
    expect(p.subject).toBe('{{vault:profile.name}}-华东大学-产品实习生');
    expect(p.subject_auto).toBe(false);
    expect(p.attachments?.[0].filename).toBe('华东大学-{{vault:profile.name}}-计算机科学-2027届.pdf');
  });

  it('模型出错重试一次：第二次成了就照常写好', async () => {
    const { draft } = await startOne();
    f.llm.push(() => { throw new Error('网关 502'); }).push(modelMail());
    expect(await draftMailForAction(f.deps, draft)).toBe('drafted');
    expect(f.llm.calls).toHaveLength(2);
  });

  it('两次都不成：draft_mail failed + 一句人话，不排 send_mail', async () => {
    const { draft } = await startOne();
    f.llm.push(() => { throw new Error('网关 502'); }).push(JSON.stringify({ email: { subject: '', body: '' } }));
    expect(await draftMailForAction(f.deps, draft)).toBe('failed');
    expect(f.repos.getAction(draft.id)!.status).toBe('failed');
    expect(JSON.parse(f.repos.getAction(draft.id)!.result_json!).error).toBe('邮件没写成，再试一次');
    expect(f.repos.listActions().some(a => a.kind === 'send_mail')).toBe(false);
  });

  it('没连邮箱不是失败：照样写好，发件邮箱留空', async () => {
    const { draft } = await startOne();
    f.llm.push(modelMail());
    expect(await draftMailForAction(f.deps, draft)).toBe('drafted');
    expect(parseSendMailPayload(sendOf().id, sendOf().payload_json).account_id).toBe('');
  });

  it('老数据懒补：库里没记投递邮箱、JD 原文里写了的，开始投前认出来并落库，走邮件', async () => {
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'old', title: '产品实习生', company_name: '老岗位', jd_raw: internJd('老岗位', 'old') });
    f.repos.db.update('job', job.id, { apply_email: null });
    expect(planJobs(f.repos, f.store, [job.id]).ready).toEqual([job.id]);
    expect(f.repos.getJob(job.id)!.apply_email).toBe('hr@old.com');
    const none = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'none', title: '运营', company_name: '没写' });
    expect(planJobs(f.repos, f.store, [none.id]).skipped).toEqual([{ job_id: none.id, reason: '没写怎么投' }]);
  });

  it('起草器：同时最多两封；重启后写到一半的放回队列重写；已写完的不会再写', async () => {
    for (const [c, d] of [['甲', 'a'], ['乙', 'b'], ['丙', 'c']]) {
      const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: c, title: '运营实习生', company_name: c, jd_raw: internJd(c, d) });
      await applyJobs(f.deps, [job.id]);
    }
    const stuck = f.repos.listActions('approved').find(a => a.kind === 'draft_mail')!;
    f.repos.claimAction(stuck.id);
    const drafter = new MailDrafter({ repos: f.repos, draft: a => draftMailForAction(f.deps, a) });
    expect(drafter.recover()).toBe(1);
    let peak = 0; let running = 0;
    const gated = new MailDrafter({ repos: f.repos, draft: async a => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 5)); running--; return draftMailForAction(f.deps, a); } });
    for (let i = 0; i < 3; i++) f.llm.push(modelMail());
    await gated.drain();
    expect(peak).toBe(2);
    expect(f.repos.listActions().filter(a => a.kind === 'send_mail')).toHaveLength(3);
    await gated.drain();
    expect(f.llm.calls).toHaveLength(3);
  });
});
