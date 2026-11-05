/**
 * 发信的几道保险（阶段一验收修复 S1–S4）：
 *  S1 授权码缺失 → 动作 failed（等你里「没发出去 · 邮箱授权失效了」），不再卡在 approved 谁也看不见；
 *  S2 进程中断留下的发信动作：发到一半的 → failed（不确定发没发出去，绝不自动重发）；批准后没发的 → 放回待审；
 *  S3 起草幂等：排完 send_mail、还没置 done 进程就没了，重跑认那一封，不写第二封；
 *  S4 发送最后一道关：同一份投递已经发出过投递邮件，第二封不发（rejected，不算失败）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildAsks, MAIL_AUTH_FAILED_REASON, MAIL_SEND_INTERRUPTED_REASON, type MailAccount } from '@career/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIL_TOTAL_MAX_BYTES } from '../../../shared/careerMailApply';
import { applyJobs } from '../batch-apply';
import { loadCore } from '../core-module';
import { setMailCredentialsPath, setMailPassword } from '../mail/credentials';
import { executeApprovedSendMails, MISSING_PASSWORD_ERROR, type SendMailPayload } from '../mail/send';
import { draftMailForAction } from './drafter';
import { parseSendMailPayload } from './payload';
import { recoverInterruptedSends, STALE_SEND_MS } from './runner';
import { internJd, mailFixture, modelMail, type MailFixture } from './test-fixture';

vi.mock('../../sse', () => ({ broadcast: vi.fn() }));

const core = await loadCore();

describe('发信的几道保险', () => {
  let dir: string;
  let f: MailFixture;
  let account: MailAccount;
  const sent: SendMailPayload[] = [];
  const sendDeps = () => ({ repos: f.repos, core, llm: null, broadcast: () => undefined, sessionId: () => 'global', vault: f.vault, transport: async (_a: MailAccount, _p: string, m: SendMailPayload) => { sent.push(m); return { messageId: `<s${sent.length}@x>` }; } });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'career-mail-safety-'));
    setMailCredentialsPath(join(dir, 'creds.json'));
    f = await mailFixture(dir);
    account = f.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    f.store.createResumeMaster({ name: '产品方向', schema_json: { basics: {} } });
    // 到岗信息已经填过：只看发信这一段
    for (const [field, value] of [['internDaysPerWeek', '4'], ['internMonths', '6'], ['availableDate', '随时']]) f.vault.set({ scope: 'profile', field, value, sensitive: false });
    sent.length = 0;
  });
  afterEach(() => { setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

  /** 一家邮件岗位开始投并写好，返回待发的 send_mail。 */
  async function pendingSend(company = '甲科技', domain = 'jia') {
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: company, title: '产品实习生', company_name: company, jd_raw: internJd(company, domain) });
    const res = await applyJobs(f.deps, [job.id]);
    f.llm.push(modelMail());
    await draftMailForAction(f.deps, f.repos.getAction(res.started[0])!);
    return f.repos.listActions('pending_review').find(a => a.kind === 'send_mail' && a.application_id === f.repos.getAction(res.started[0])!.application_id)!;
  }

  it('S1 没存授权码：动作置 failed，等你里是「邮箱授权失效了」那件，不留在 approved', async () => {
    const send = await pendingSend();
    f.repos.reviewActions([send.id], 'approved', 'user');
    const [res] = await executeApprovedSendMails(sendDeps(), [send.id]);
    expect(res).toMatchObject({ ok: false, error: MISSING_PASSWORD_ERROR });
    expect(f.repos.getAction(send.id)!.status).toBe('failed');
    expect(sent).toHaveLength(0);
    const ask = buildAsks(f.repos, new Date().toISOString()).find(a => a.kind === 'failed');
    expect(ask).toMatchObject({ title: '1 封没发出去', detail: MAIL_AUTH_FAILED_REASON, mail_failed: { stage: 'send', reauth: true } });
  });

  it('S2 启动清扫：发到一半的置 failed（不重发），批准后没发的放回待审；刚动过的不碰', async () => {
    setMailPassword(account.id, 'code');
    const a = await pendingSend('甲科技', 'jia');
    const b = await pendingSend('乙数据', 'yi');
    const c = await pendingSend('丙智能', 'bing');
    f.repos.reviewActions([a.id, b.id, c.id], 'approved', 'user');
    expect(f.repos.claimAction(a.id).ok).toBe(true);
    const later = Date.now() + STALE_SEND_MS + 1000;
    // c 是刚批准的（别的侧车可能正在发）：只有超过新鲜度保护才扫
    f.repos.db.run(`UPDATE action_queue SET updated_at=? WHERE id=?`, [new Date(later - 1000).toISOString(), c.id]);
    expect(recoverInterruptedSends(f.repos, later)).toEqual({ failed: 1, reopened: 1 });
    expect(f.repos.getAction(a.id)).toMatchObject({ status: 'failed' });
    expect(JSON.parse(f.repos.getAction(a.id)!.result_json!).error).toBe(MAIL_SEND_INTERRUPTED_REASON);
    expect(f.repos.getAction(b.id)!.status).toBe('pending_review');
    expect(f.repos.getAction(c.id)!.status).toBe('approved');
    expect(sent).toHaveLength(0);
    const ask = buildAsks(f.repos, new Date().toISOString()).find(x => x.kind === 'failed');
    expect(ask).toMatchObject({ title: '1 封没发出去', detail: MAIL_SEND_INTERRUPTED_REASON, mail_failed: { stage: 'send', reauth: false } });
  });

  it('S3 起草幂等：上次排完 send_mail 没来得及收尾，重跑认那一封，不调模型、不排第二封', async () => {
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: 'x', title: '产品实习生', company_name: '甲科技', jd_raw: internJd('甲科技', 'jia') });
    const draftId = (await applyJobs(f.deps, [job.id])).started[0];
    f.llm.push(modelMail());
    await draftMailForAction(f.deps, f.repos.getAction(draftId)!);
    const first = f.repos.listActions().filter(a => a.kind === 'send_mail');
    expect(first).toHaveLength(1);
    // 模拟崩溃：send_mail 已排出，draft_mail 却还停在 executing；重启后放回 approved 再跑一次
    f.repos.db.run(`UPDATE action_queue SET status='executing', result_json=NULL WHERE id=?`, [draftId]);
    expect(f.repos.requeueAction(draftId)).toBe(true);
    expect(await draftMailForAction(f.deps, f.repos.getAction(draftId)!)).toBe('drafted');
    expect(f.llm.calls).toHaveLength(1);
    expect(f.repos.listActions().filter(a => a.kind === 'send_mail').map(a => a.id)).toEqual(first.map(a => a.id));
    expect(JSON.parse(f.repos.getAction(draftId)!.result_json!)).toEqual({ send_action_id: first[0].id });
  });

  it('S4 同一份投递两封待发：一起批准只发出一封，另一封 rejected、不算失败', async () => {
    setMailPassword(account.id, 'code');
    const one = await pendingSend();
    const twin = f.repos.enqueueAction('send_mail', JSON.parse(one.payload_json), one.application_id);
    f.repos.reviewActions([one.id, twin.id], 'approved', 'user');
    const results = await executeApprovedSendMails(sendDeps(), [one.id, twin.id]);
    expect(sent).toHaveLength(1);
    expect(results).toEqual([expect.objectContaining({ action_id: one.id, ok: true }), { action_id: twin.id, ok: true, skipped: 'already_sent' }]);
    expect(f.repos.getAction(twin.id)!.status).toBe('rejected');
    expect(buildAsks(f.repos, new Date().toISOString()).some(a => a.kind === 'failed')).toBe(false);
  });

  it('附件加起来超过 20MB（第三轮 R1）：发送前再查一遍，不发、放回待审', async () => {
    setMailPassword(account.id, 'code');
    const one = await pendingSend();
    const p = parseSendMailPayload(one.id, one.payload_json);
    const big = join(dir, 'big.zip');
    writeFileSync(big, Buffer.alloc(MAIL_TOTAL_MAX_BYTES + 1));
    f.repos.updateActionPayload(one.id, { ...p, attachments: [...(p.attachments ?? []), { id: 'file:big', kind: 'file', file_id: 'big', path: big, filename: 'big.zip' }] });
    f.repos.reviewActions([one.id], 'approved', 'user');
    const [res] = await executeApprovedSendMails(sendDeps(), [one.id]);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('20MB') });
    expect(sent).toHaveLength(0);
    expect(f.repos.getAction(one.id)!.status).toBe('pending_review');
  });
});
