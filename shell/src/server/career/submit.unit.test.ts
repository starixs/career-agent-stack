import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { evaluateSubmitGate, persistDriveOutcome } from './drive-outcome';
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

function driveResult(review: Record<string, unknown> | null, extra: Record<string, unknown> = {}): Ev[] {
  return [{ type: 'result', op: 'drive', result: {
    status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply', submitButton: '提交申请',
    filled: [{ fieldId: 'f0', label: '姓名', value: '{{vault:profile.name}}', source: 'profile' }], needsUser: [], drafts: [], mismatches: [], uploads: [],
    ...(review ? { review: { rows: [{ fieldId: 'f0', label: '姓名', required: true, status: 'ok' }], requiredTotal: 1, requiredFilled: 1, attention: 0, formSignature: SIG, openAnswersHash: 'h-open-1', ...review } } : {}),
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
    // 没有填后检查结果：不知道填没填完，提交不入队（交给用户补 / 核对）
    expect(() => persist(repos, driveResult(null))).toThrow('unexpected handoff');
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

describe('提交门槛：全部过关才入队提交，否则交给用户补', () => {
  const ok = (label: string) => ({ label, required: true, status: 'ok' });
  const run = (review: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    const repos = createMemoryRepos();
    const { app, fill } = seedFill(repos);
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const reviews: Array<{ ids: string[]; summary: string; data?: Record<string, unknown> }> = [];
    const events = driveResult(null, { ...(review ? { review: { attention: 0, formSignature: SIG, openAnswersHash: 'h', ...review } } : {}), ...extra });
    const out = persistDriveOutcome({ repos, action: fill, taskId: task.id, events, changed: () => {}, review: (ids, _k, summary, data) => reviews.push({ ids, summary, data }) });
    return { repos, app, fill, out, reviews };
  };

  it('必填 12/12 已填并核对：入队提交，卡片文案按实际数字生成、带审阅清单', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ok(`字段${i}`));
    const { repos, out, reviews } = run({ rows, requiredTotal: 12, requiredFilled: 12 }, { submitButton: '投递' });
    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect(repos.getAction(out.submitActionId)!.status).toBe('pending_review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0].summary).toBe('「甲 后端」必填 12/12 已填好并核对过，停在「投递」前');
    expect((reviews[0].data?.review as { requiredFilled: number }).requiredFilled).toBe(12);
  });

  const notReady: Array<[string, Record<string, unknown> | null, Record<string, unknown>, RegExp]> = [
    ['必填没填满', { rows: [ok('姓名'), { label: '毕业时间', required: true, status: 'empty', reason: '必填项还是空的' }], requiredTotal: 2, requiredFilled: 1 }, {}, /毕业时间/],
    ['有需要你填的项', { rows: [ok('姓名')], requiredTotal: 1, requiredFilled: 1 }, { needsUser: [{ label: '期望薪资', note: '答案库里没有' }] }, /期望薪资/],
    ['值没生效', { rows: [ok('姓名')], requiredTotal: 1, requiredFilled: 1 }, { mismatches: [{ fieldId: 'x', label: '学历', expected: '本科', actual: '' }] }, /学历/],
    ['网站报错', { rows: [ok('姓名'), { label: '手机号格式不正确', required: true, status: 'site_error' }], requiredTotal: 1, requiredFilled: 1 }, {}, /手机号格式不正确/],
    ['附件没回显', { rows: [ok('姓名')], requiredTotal: 1, requiredFilled: 1 }, { uploads: [{ fieldId: 'f', file: '/x/张三.pdf', echoed: false }] }, /简历附件/],
    ['读不到任何行（必填数不可信）', { rows: [], requiredTotal: 0, requiredFilled: 0 }, {}, /必填项核对/],
    ['引擎说读回核验没通过', { rows: [ok('姓名')], requiredTotal: 1, requiredFilled: 1, verified: false }, {}, /必填项核对/],
    ['行级读回核验没通过', { rows: [{ ...ok('姓名'), verified: false, reason: '页面上读回来是空的' }], requiredTotal: 1, requiredFilled: 1 }, {}, /姓名/],
    ['没有填后检查', null, {}, /填后检查/],
  ];
  for (const [name, review, extra, label] of notReady) {
    it(`${name}：不入队提交，填表停在 needs_user + missing_info 接管`, () => {
      const { repos, app, fill, out, reviews } = run(review, extra);
      expect(out.kind).toBe('handoff');
      if (out.kind !== 'handoff') return;
      expect(out.reason).toBe('missing_info');
      expect(out.gate?.ready).toBe(false);
      expect(out.message).toMatch(/^还差 \d+ 项要你补/);
      expect(out.gate!.gaps.map(g => g.label).join(' ')).toMatch(label);
      expect(repos.listActions().filter(a => a.kind === 'submit')).toHaveLength(0);
      expect(reviews).toHaveLength(0);
      expect(repos.getAction(fill.id)!.status).toBe('needs_user');
      expect(repos.openHandoffs().map(h => h.reason)).toEqual(['missing_info']);
      expect(repos.getApplication(app.id)!.stage).toBe('needs_user');
    });
  }

  it('auto 模式也过不了门槛：没填完不会被自动提交', () => {
    const repos = createMemoryRepos();
    setAutoMode(repos, true);
    const { fill } = seedFill(repos);
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: fill, taskId: task.id, changed: () => {}, events: driveResult({ rows: [ok('a'), { label: 'b', required: true, status: 'empty' }], requiredTotal: 2, requiredFilled: 1 }) });
    expect(out.kind).toBe('handoff');
    expect(repos.listActions().filter(a => a.kind === 'submit')).toHaveLength(0);
  });

  it('引擎新字段：选填留空（empty_optional）不拦提交；requiredTrusted=false 一律不算过关并带上引擎的说明', () => {
    expect(evaluateSubmitGate({ review: { rows: [ok('姓名'), { label: '个人网站', required: false, status: 'empty_optional' }], requiredTotal: 1, requiredFilled: 1, attention: 0, requiredTrusted: true } }).ready).toBe(true);
    const g = evaluateSubmitGate({ review: { rows: [ok('姓名')], requiredTotal: 1, requiredFilled: 1, attention: 0, requiredTrusted: false, requiredNote: '页面上有 6 个必填星号，只认出 1 个' } });
    expect(g.ready).toBe(false);
    expect(g.gaps[0].reason).toContain('6 个必填星号');
    expect(evaluateSubmitGate({ review: { rows: [{ label: '学校', required: true, status: 'unverified' }], requiredTotal: 1, requiredFilled: 0, attention: 1 } }).gaps.map(x => x.status)).toEqual(['unverified']);
  });

  it('evaluateSubmitGate：新字段存在时优先用（review.verified=true 时 0 个必填也可信）', () => {
    expect(evaluateSubmitGate({ review: { rows: [{ label: 'x', required: false, status: 'ok' }], requiredTotal: 0, requiredFilled: 0, attention: 0, verified: true } }).ready).toBe(true);
    expect(evaluateSubmitGate({ review: { rows: [ok('x')], requiredTotal: 2, requiredFilled: 3, attention: 0 } }).ready).toBe(false);
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
