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
