import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { persistDriveOutcome } from './drive-outcome';
import { SubmitExecutor, confirmSubmitResult, executeSubmitAction } from './submit-executor';
import { LEARN_THRESHOLD, decideSubmit, getPageTrust, recordSubmitOutcome, setAutoMode } from './submit-policy';
import { createMemoryRepos } from './test-db';

// 阶段 1：填后检查 → 提交策略（默认人审 / auto 模式 / 自学习免审）→ 提交执行器。

type Ev = Record<string, unknown>;
const SIG = 'sig-form-a';

function seedFill(repos: Repos, packet?: { resumeSha: string }) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j${Math.random()}`, title: '后端', company_name: '甲', url: 'https://x.com/apply' });
  const app = repos.createApplication(job.id);
  repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
  const pkt = packet ? repos.createPacket({ application_id: app.id, job_id: job.id, resume_pdf_sha256: packet.resumeSha }) : undefined;
  const fill = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id, ...(pkt ? { packet_id: pkt.id } : {}) }, app.id);
  repos.reviewActions([fill.id], 'approved');
  repos.claimAction(fill.id);
  return { app, fill: repos.getAction(fill.id)! };
}

function driveResult(review: Partial<{ attention: number; formSignature: string; openAnswersHash: string }> | null, extra: Record<string, unknown> = {}): Ev[] {
  return [{ type: 'result', op: 'drive', result: {
    status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply', submitButton: '提交申请',
    filled: [{ fieldId: 'f0', label: '姓名', value: '{{vault:profile.name}}', source: 'profile' }], needsUser: [], drafts: [], mismatches: [], uploads: [],
    ...(review ? { review: { rows: [], requiredTotal: 1, requiredFilled: 1, attention: 0, formSignature: SIG, openAnswersHash: 'h-open-1', ...review } } : {}),
    ...extra,
  } }];
}

function persist(repos: Repos, events: Ev[], packet?: { resumeSha: string }) {
  const { app, fill } = seedFill(repos, packet);
  const task = repos.createTask({ title: 't', kind: 'apply' });
  const out = persistDriveOutcome({ repos, action: fill, taskId: task.id, events, changed: () => {} });
  if (out.kind !== 'done') throw new Error(`unexpected ${out.kind}`);
  return { app, submit: repos.getAction(out.submitActionId)!, out };
}

describe('提交策略', () => {
  it('默认：检查全部通过也要人批准', () => {
    const repos = createMemoryRepos();
    const { submit, out } = persist(repos, driveResult({}));
    expect(submit.status).toBe('pending_review');
    expect(out.autoApproved).toBeUndefined();
    const payload = JSON.parse(submit.payload_json);
    expect(payload).toMatchObject({ submitButton: '提交申请', formSignature: SIG, openAnswersHash: 'h-open-1' });
    expect(payload.filled[0].value).toBe('{{vault:profile.name}}');
  });

  it('auto 模式：检查全部通过直接批准；有需要人看的项照样停下；没有检查结果按需要人看', () => {
    const repos = createMemoryRepos();
    setAutoMode(repos, true);
    const a = persist(repos, driveResult({}));
    expect(a.submit.status).toBe('approved');
    expect(a.submit.approved_by).toBe('auto');
    const b = persist(repos, driveResult({ attention: 2 }));
    expect(b.submit.status).toBe('pending_review');
    const c = persist(repos, driveResult(null));
    expect(c.submit.status).toBe('pending_review');
  });

  it(`自学习：同一张表连续 ${LEARN_THRESHOLD} 次人工直接通过后免确认；简历或开放题变了就停`, () => {
    const repos = createMemoryRepos();
    const fp = { formSignature: SIG, openAnswersHash: 'h-open-1', resumeSha: 'r1' };
    for (let i = 0; i < LEARN_THRESHOLD; i++) {
      expect(decideSubmit(repos, { ...fp, attention: 0 }).approve).toBe(false);
      recordSubmitOutcome(repos, { ...fp, approvedBy: 'user', status: 'submitted', edits: 0 });
    }
    const ok = decideSubmit(repos, { ...fp, attention: 0 });
    expect(ok).toMatchObject({ approve: true, by: 'learned' });
    expect(decideSubmit(repos, { ...fp, resumeSha: 'r2', attention: 0 })).toMatchObject({ approve: false, reason: expect.stringMatching(/简历/) });
    expect(decideSubmit(repos, { ...fp, openAnswersHash: 'h-open-2', attention: 0 })).toMatchObject({ approve: false, reason: expect.stringMatching(/开放题/) });
    expect(decideSubmit(repos, { ...fp, attention: 1 }).approve).toBe(false);
    // 免审后的成功不算"人工确认"，不继续累加；一次页面改动就清零
    recordSubmitOutcome(repos, { ...fp, approvedBy: 'learned', status: 'submitted', edits: 0 });
    expect(getPageTrust(repos, SIG)!.streak).toBe(LEARN_THRESHOLD);
    recordSubmitOutcome(repos, { ...fp, approvedBy: 'user', status: 'submitted', edits: 1 });
    expect(getPageTrust(repos, SIG)!.streak).toBe(0);
  });

  it('自学习满了之后：落库时直接批准（learned），简历快照来自材料包', () => {
    const repos = createMemoryRepos();
    const fp = { formSignature: SIG, openAnswersHash: 'h-open-1', resumeSha: 'pdf-sha-1' };
    for (let i = 0; i < LEARN_THRESHOLD; i++) recordSubmitOutcome(repos, { ...fp, approvedBy: 'user', status: 'submitted', edits: 0 });
    const same = persist(repos, driveResult({}), { resumeSha: 'pdf-sha-1' });
    expect(same.submit.approved_by).toBe('learned');
    const other = persist(repos, driveResult({}), { resumeSha: 'pdf-sha-2' });
    expect(other.submit.status).toBe('pending_review');
  });
});

describe('提交执行器', () => {
  const submitResult = (status: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'result', op: 'submit', result: { status, message: status, edits: [], ...extra } });

  it('成功：动作 done、投递 applied、页面上的改动写回答案库、计入自学习', async () => {
    const repos = createMemoryRepos();
    const { app, submit } = persist(repos, driveResult({}));
    repos.reviewActions([submit.id], 'approved', 'user');
    const bodies: Ev[] = [];
    const out = await executeSubmitAction({ repos, broadcast: () => {}, run: async (body, onEvent) => { bodies.push(body); const ev = submitResult('submitted', { evidence: '投递成功', edits: [{ label: '期望城市', before: '北京', after: '上海' }] }); onEvent(ev); return [ev]; } }, submit.id);
    expect(out.status).toBe('submitted');
    expect(bodies[0]).toMatchObject({ op: 'submit', applicationId: app.id, submitButton: '提交申请' });
    expect(repos.getAction(submit.id)!.status).toBe('done');
    expect(repos.getApplication(app.id)!.stage).toBe('applied');
    expect(repos.findAnswer('期望城市')!.answer).toBe('上海');
    expect(repos.pendingAnswerEvents().some(e => e.kind === 'corrected')).toBe(true);
    expect(getPageTrust(repos, SIG)!.streak).toBe(0); // 有改动 → 不算"没改直接通过"
  });

  it('同一个提交只执行一次（执行器轮询与审批路由同时触发）', async () => {
    const repos = createMemoryRepos();
    const { submit } = persist(repos, driveResult({}));
    repos.reviewActions([submit.id], 'approved', 'user');
    let calls = 0;
    const deps = { repos, broadcast: () => {}, run: async (_b: Ev, onEvent: (e: Ev) => void) => { calls++; const ev = submitResult('submitted'); onEvent(ev); return [ev]; } };
    await Promise.all([executeSubmitAction(deps, submit.id), executeSubmitAction(deps, submit.id)]);
    expect(calls).toBe(1);
  });

  it('网站拒绝：回到待审（批准作废），自学习清零；结果不确定：不重试，等用户确认', async () => {
    const repos = createMemoryRepos();
    recordSubmitOutcome(repos, { formSignature: SIG, openAnswersHash: 'h-open-1', resumeSha: null, approvedBy: 'user', status: 'submitted', edits: 0 });
    const a = persist(repos, driveResult({}));
    repos.reviewActions([a.submit.id], 'approved', 'user');
    await executeSubmitAction({ repos, broadcast: () => {}, run: async (_b, on) => { const ev = submitResult('failed', { errors: ['手机号格式不正确'] }); on(ev); return [ev]; } }, a.submit.id);
    expect(repos.getAction(a.submit.id)).toMatchObject({ status: 'pending_review', approved_hash: null });
    expect(getPageTrust(repos, SIG)!.streak).toBe(0);

    const b = persist(repos, driveResult({}));
    repos.reviewActions([b.submit.id], 'approved', 'user');
    const executor = new SubmitExecutor({ repos, broadcast: () => {}, run: async (_b, on) => { const ev = submitResult('uncertain'); on(ev); return [ev]; } });
    await executor.tick();
    expect(repos.getAction(b.submit.id)!.status).toBe('needs_user');
    expect(await executor.tick()).toEqual([]); // 不会再点一次
    confirmSubmitResult(repos, b.submit.id, true);
    expect(repos.getApplication(b.app.id)!.stage).toBe('applied');
  });

  it('页面已经不在（浏览器关过）：回到待审并说明原因', async () => {
    const repos = createMemoryRepos();
    const { submit } = persist(repos, driveResult({}));
    repos.reviewActions([submit.id], 'approved', 'user');
    const out = await executeSubmitAction({ repos, broadcast: () => {}, run: async (_b, on) => { const ev = { type: 'error', status: 410, code: 'APPLICATION_PAGE_GONE', error: '这份网申填好的页面已经关闭' }; on(ev); return [ev]; } }, submit.id);
    expect(out.status).toBe('failed');
    expect(out.message).toMatch(/页面已经关闭/);
    expect(repos.getAction(submit.id)!.status).toBe('pending_review');
  });
});
