import { describe, expect, it } from 'vitest';

import { isTransientDriveError, persistDriveOutcome } from './drive-outcome';
import { createMemoryRepos } from './test-db';

// 交还后页面身份核对没过：不判失败，重新交给用户（回到网申页面再交还就能接着填）。

describe('persistDriveOutcome：页面身份不对', () => {
  it('APPLICATION_PAGE_MOVED → 动作 needs_user、开新接管、带上该怎么做；不是 failed', () => {
    const repos = createMemoryRepos();
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'mt1', title: 'AI 应用开发', company_name: '美团', url: 'https://zhaopin.meituan.com/x' });
    const app = repos.createApplication(job.id);
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url }, app.id);
    repos.reviewActions([action.id], 'approved');
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const changed: string[] = [];
    const message = '这份网申的页面现在停在 taobao.com，不是网申网站 meituan.com。请回到网申页面后再交还。';
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'continue', events: [{ type: 'error', status: 410, code: 'APPLICATION_PAGE_MOVED', error: message }], changed: (...t) => changed.push(...t) });
    expect(out).toMatchObject({ kind: 'handoff', userAction: message });
    expect(repos.getAction(action.id)?.status).toBe('needs_user');
    expect(repos.openHandoffs().map(h => h.action_id)).toEqual([action.id]);
    expect(changed).toContain('handoff');
  });

  it('续填时原页面没了（浏览器重启过）APPLICATION_PAGE_GONE → 放回队列重新打开，不交给用户找页面', () => {
    const repos = createMemoryRepos();
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'mk1', title: '软件开发', company_name: '联发科技', url: 'https://mediatek.zhiye.com/' });
    const app = repos.createApplication(job.id);
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url }, app.id);
    repos.reviewActions([action.id], 'approved');
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'continue', events: [{ type: 'error', status: 410, code: 'APPLICATION_PAGE_GONE', error: '找不到这份网申的页面了，当前页面在 about:blank' }], changed: () => {} });
    expect(out.kind).toBe('transient');
    expect(repos.getAction(action.id)?.status).toBe('approved');
    expect(repos.openHandoffs()).toEqual([]);
  });

  it('真错误（如渲染进程崩了的 500）照旧判失败', () => {
    const repos = createMemoryRepos();
    const action = repos.enqueueAction('fill_form', { url: 'https://x' });
    repos.reviewActions([action.id], 'approved');
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'start', events: [{ type: 'error', status: 500, error: '渲染进程崩了' }], changed: () => {} });
    expect(out.kind).toBe('failed');
    expect(repos.getAction(action.id)?.status).toBe('failed');
  });
});

describe('persistDriveOutcome：瞬时 / 可抢占错误不判死', () => {
  it('501 引擎未就绪（start）→ 放回 approved、任务 queued，不是 failed', () => {
    const repos = createMemoryRepos();
    const action = repos.enqueueAction('fill_form', { url: 'https://x' });
    repos.reviewActions([action.id], 'approved');
    const claim = repos.claimAction(action.id);
    expect(claim.ok).toBe(true); // executing：requeue 才有 approved_hash 可回
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'start', events: [{ type: 'error', status: 501, error: '引擎未就绪' }], changed: () => {} });
    expect(out).toMatchObject({ kind: 'transient' });
    expect(repos.getAction(action.id)?.status).toBe('approved');
    expect(repos.db.get<{ status: string }>('SELECT status FROM task WHERE id=?', [task.id])?.status).toBe('queued');
  });

  it('BROWSER_CONTROL_HUMAN（continue）→ 保持 needs_user 等用户交回，不是 failed', () => {
    const repos = createMemoryRepos();
    const action = repos.enqueueAction('fill_form', { url: 'https://x' });
    repos.reviewActions([action.id], 'approved');
    repos.claimAction(action.id);
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'continue', events: [{ type: 'error', status: 409, code: 'BROWSER_CONTROL_HUMAN', error: '用户正在接管浏览器' }], changed: () => {} });
    expect(out).toMatchObject({ kind: 'transient', code: 'BROWSER_CONTROL_HUMAN' });
    expect(repos.getAction(action.id)?.status).toBe('needs_user');
  });

  it('分诊表：BUSY / HOST_STOPPING / CONTEXT_MISSING / NAVIGATION_FAILED / 501 / 503 瞬时；GONE / 500 不是', () => {
    expect(isTransientDriveError({ code: 'BROWSER_BUSY' })).toBe(true);
    expect(isTransientDriveError({ code: 'BROWSER_HOST_STOPPING' })).toBe(true);
    expect(isTransientDriveError({ code: 'BROWSER_CONTEXT_MISSING' })).toBe(true);
    expect(isTransientDriveError({ code: 'BROWSER_CONNECTION_FAILED' })).toBe(true);
    expect(isTransientDriveError({ code: 'NAVIGATION_FAILED' })).toBe(true);
    expect(isTransientDriveError({ status: 501 })).toBe(true);
    expect(isTransientDriveError({ status: 503 })).toBe(true);
    expect(isTransientDriveError({ code: 'APPLICATION_PAGE_GONE' })).toBe(false);
    expect(isTransientDriveError({ status: 500 })).toBe(false);
    expect(isTransientDriveError(undefined)).toBe(false);
  });
});

describe('浏览器没接下这次填表（HTTP 拒绝）', () => {
  it('409 用户正在接管：带着 code 变成 error 行，分诊为暂时不可用，不判这份网申失败（2026-11-02 美团）', async () => {
    const { browserRefusalLine } = await import('../tools/career-tools');
    const line = browserRefusalLine(409, JSON.stringify({ ok: false, error: '用户正在接管浏览器，等待交回', code: 'BROWSER_CONTROL_HUMAN' }));
    expect(line).toMatchObject({ type: 'error', status: 409, code: 'BROWSER_CONTROL_HUMAN' });
    expect(isTransientDriveError(line)).toBe(true);
    expect(browserRefusalLine(502, '<html>bad gateway</html>')).toEqual({ type: 'error', status: 502, error: '浏览器没有接下这次填表（HTTP 502）' });
  });
});

describe('persistDriveOutcome：submit 绑定开跑前冻结的材料包（G6）', () => {
  const REVIEW = { rows: [{ label: '姓名', required: true, status: 'ok' }], attention: 0, requiredTotal: 1, requiredFilled: 1 };
  it('submit 用运行器给的 packet_id', () => {
    const repos = createMemoryRepos();
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'jd1', title: '数据分析', company_name: '京东', url: 'https://jd.com/1' });
    const app = repos.createApplication(job.id);
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
    repos.reviewActions([action.id], 'approved');
    const packet = repos.createPacket({ application_id: app.id, job_id: job.id, resume_id: null, resume_kind: null, resume_schema_json: null, resume_pdf_path: '/tmp/x.pdf', resume_pdf_sha256: 'sha-frozen', answers: {} });
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const result = { status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://jd.com/1/form', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], review: REVIEW };
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'start', packetId: packet.id, events: [{ type: 'result', op: 'drive', result }], changed: () => {} });
    expect(out.kind).toBe('done');
    const submit = repos.listActions().find(a => a.kind === 'submit')!;
    expect(JSON.parse(submit.payload_json)).toMatchObject({ packet_id: packet.id, resumeSha: 'sha-frozen' });
  });

  it('材料包没备出来（PACKET_FAILED）：判失败、原因原样、带错误码', () => {
    const repos = createMemoryRepos();
    const action = repos.enqueueAction('fill_form', { url: 'https://x' });
    repos.reviewActions([action.id], 'approved');
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, mode: 'start', events: [{ type: 'error', status: 500, code: 'PACKET_FAILED', error: '简历 PDF 没导出来' }], changed: () => {} });
    expect(out).toMatchObject({ kind: 'failed', message: '简历 PDF 没导出来' });
    expect(JSON.parse(repos.getAction(action.id)!.result_json!)).toMatchObject({ error: '简历 PDF 没导出来', code: 'PACKET_FAILED' });
  });
});
