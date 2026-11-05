/**
 * 回信 / 跟进不编造（不变量 8）：正文里事实底稿没有的数字换成「【待补：…】」，预览里 blockers 带 unresolved，他补上才能发。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyJobs } from '../batch-apply';
import { createMemoryRepos } from '../test-db';
import { draftMailForAction } from './drafter';
import { patchMailDraft } from './edit';
import { saveMailFile } from './files';
import { guardNumbers } from './follow-drafter';
import { attachmentsOf, parseSendMailPayload } from './payload';
import { resolveMail } from './resolve';
import { internJd, mailFixture, type MailFixture } from './test-fixture';

describe('回信不编造', () => {
  const facts = '每周可实习：4 天；可连续实习：6 个月；最早到岗：随时；毕业时间：2027-06';

  it('事实里有的数字留着，没有的换成待补', () => {
    expect(guardNumbers('我每周可以实习4天，2027届。', facts)).toBe('我每周可以实习4天，2027届。');
    expect(guardNumbers('我可以连续实习8个月，12月3日到岗。', facts)).toBe('我可以连续实习【待补：核对「8」】个月，【待补：核对「12」】月【待补：核对「3」】日到岗。');
  });

  it('正文带待补的那封：blockers 带 unresolved；补上就没有', () => {
    const repos = createMemoryRepos();
    const account = repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    const base = { account_id: account.id, to: 'hr@jia.com', subject: 'Re: 关于实习', purpose: 'reply' };
    const gap = repos.enqueueAction('send_mail', { ...base, body: '我最早【待补：最早到岗日期】到岗。' });
    expect(resolveMail({ repos, vault: null }, gap).blockers).toEqual(['unresolved']);
    const done = repos.enqueueAction('send_mail', { ...base, body: '我最早下周一到岗。' });
    expect(resolveMail({ repos, vault: null }, done).blockers).toEqual([]);
  });
});

describe('跟进：帮他再争取一下（第三轮 R3）', () => {
  let dir: string;
  let f: MailFixture;
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'career-mail-follow-')); f = await mailFixture(dir); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('投递邮件记下用过的主张；跟进时「上次用过的」和「还没用过的」分开喂，新理由只从没用过的里挑；只附原来那份简历', async () => {
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
    const exp = f.repos.createExperience({ title: '校园项目' });
    const used = f.repos.addClaim({ experience_id: exp.id, text: '做过三次竞品调研', status: 'user_confirmed' });
    const fresh = f.repos.addClaim({ experience_id: exp.id, text: '搭过一份周报看板', status: 'user_confirmed' });
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'f', title: '产品实习生', company_name: '甲科技', jd_raw: internJd('甲科技', 'jia') });
    const draftId = (await applyJobs(f.deps, [job.id])).started[0];
    f.llm.push(JSON.stringify({ email: { subject: '', body: '您好！我做过三次竞品调研。' }, attachment_name: '', matches_used: [{ claim_id: used.id, text: used.text }] }));
    await draftMailForAction(f.deps, f.repos.getAction(draftId)!);
    const send = f.repos.listActions().find(a => a.kind === 'send_mail')!;
    expect(parseSendMailPayload(send.id, send.payload_json).claims_used).toEqual([used.id]);
    // 原投递邮件另附了一份作品集文件；当它已发出
    const works = saveMailFile(f.repos, dir, { name: '作品集.pdf', base64: Buffer.from('%PDF w').toString('base64') });
    await patchMailDraft(f.deps, send.id, { add_file_id: works.id });
    const account = f.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    const out = f.repos.insertMailMessage({ account_id: account.id, uid: null, message_id: '<orig@qq.com>', in_reply_to: null, direction: 'out', from_addr: 'me@qq.com', to_addr: 'hr@jia.com', subject: '应聘【产品实习生】', snippet: '', body_text: '', received_at: new Date().toISOString(), relevance: 'job', kind: null, inbox_item_id: null, application_id: send.application_id, action_id: send.id })!;
    const follow = f.repos.enqueueAction('draft_mail', { purpose: 'followup', job_id: job.id, application_id: send.application_id, reply_to_mail_id: out.id }, send.application_id, true);
    f.llm.push(req => {
      const prompt = req.messages[0].content;
      const [before, after] = prompt.split('还没用过的主张');
      expect(prompt).toContain('帮他再争取一下');
      expect(prompt).toContain('岗位职责：参与需求分析');
      expect(before).toContain(used.text);
      expect(after).toContain(fresh.text);
      expect(after).not.toContain(used.text);
      return JSON.stringify({ body: '您好！我投递了贵司产品实习生岗位，还搭过一份周报看板，正好用得上岗位里的数据分析。需要补什么材料随时告诉我。' });
    });
    expect(await draftMailForAction(f.deps, follow)).toBe('drafted');
    const fu = f.repos.listActions('pending_review').find(a => a.kind === 'send_mail' && parseSendMailPayload(a.id, a.payload_json).purpose === 'followup')!;
    expect(attachmentsOf(parseSendMailPayload(fu.id, fu.payload_json)).map(a => a.kind)).toEqual(['resume']);
  });
});
