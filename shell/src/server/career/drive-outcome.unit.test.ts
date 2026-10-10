import { describe, expect, it } from 'vitest';

import { persistDriveOutcome } from './drive-outcome';
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
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, events: [{ type: 'error', status: 410, code: 'APPLICATION_PAGE_MOVED', error: message }], changed: (...t) => changed.push(...t) });
    expect(out).toMatchObject({ kind: 'handoff', userAction: message });
    expect(repos.getAction(action.id)?.status).toBe('needs_user');
    expect(repos.openHandoffs().map(h => h.action_id)).toEqual([action.id]);
    expect(changed).toContain('handoff');
  });

  it('别的路由错误照旧判失败', () => {
    const repos = createMemoryRepos();
    const action = repos.enqueueAction('fill_form', { url: 'https://x' });
    repos.reviewActions([action.id], 'approved');
    const task = repos.createTask({ title: 't', kind: 'apply' });
    const out = persistDriveOutcome({ repos, action: repos.getAction(action.id)!, taskId: task.id, events: [{ type: 'error', status: 501, error: '引擎未就绪' }], changed: () => {} });
    expect(out.kind).toBe('failed');
    expect(repos.getAction(action.id)?.status).toBe('failed');
  });
});
