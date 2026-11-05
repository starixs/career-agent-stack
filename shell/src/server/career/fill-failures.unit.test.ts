import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { BATCH_COMMAND_KEY, type BatchCommand } from './batch-runner';
import { asksFor } from './delivery';
import { FailedAskError, retryFailedAsk, scheduleFillRetry, takeOverFailedAsk } from './fill-failures';
import { viewedApp } from './live-pin';
import { createMemoryRepos } from './test-db';

/** 一份批准过、跑失败了的填表（和 drive-outcome 的 fail 一样：动作 failed、投递 blocked）。 */
function failedFill(repos: Repos, company: string, error = 'Timeout 30000ms exceeded') {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '产品实习', company_name: company, url: `https://${company}.test/apply` });
  const app = repos.createApplication(job.id);
  repos.jumpTo(app.id, 'pending');
  const action = repos.enqueueAction('fill_form', { url: job.url, job_id: job.id }, app.id, true);
  repos.setActionStatus(action.id, 'failed', { error });
  repos.transition(app.id, 'blocked', error);
  return { app, action };
}
const failedAsk = (repos: Repos) => asksFor(repos).find(a => a.kind === 'failed');

describe('填表没成：自动再试一次 → 等你里再试一次 / 我自己来', () => {
  it('对话里跑失败：第一次放回队列并叫醒后台只填这一份；第二次不再试，出现在等你', () => {
    const repos = createMemoryRepos();
    const { app, action } = failedFill(repos, '甲');
    expect(scheduleFillRetry(repos, action.id)).toBe('retrying');
    expect(repos.kvGet<BatchCommand>(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'run', ids: [action.id] });
    expect(failedAsk(repos)).toBeUndefined();
    repos.kvSet(BATCH_COMMAND_KEY, null);
    repos.setActionStatus(action.id, 'failed', { error: 'Timeout 30000ms exceeded' });
    expect(scheduleFillRetry(repos, action.id)).toBe('exhausted');
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeNull();
    expect(failedAsk(repos)).toMatchObject({ title: '1 家没填成', application_ids: [app.id] });
  });

  it('再试一次：整件放回队列、只填这几份，等你里就不在了', () => {
    const repos = createMemoryRepos();
    const a = failedFill(repos, '甲');
    const b = failedFill(repos, '乙', "locator('#major') not found");
    const ask = failedAsk(repos)!;
    expect(ask.title).toBe('2 家没填成');
    expect(retryFailedAsk(repos, ask.id).sort()).toEqual([a.action.id, b.action.id].sort());
    expect(repos.getAction(a.action.id)!.status).toBe('approved');
    expect(repos.kvGet<BatchCommand>(BATCH_COMMAND_KEY)?.ids?.sort()).toEqual([a.action.id, b.action.id].sort());
    expect(() => retryFailedAsk(repos, ask.id)).toThrow(FailedAskError);
  });

  it('我自己来：开接管（等你过一下）、投递到 needs_user、现场画面切到那一家；只点一家就只接那一家', () => {
    const repos = createMemoryRepos();
    const a = failedFill(repos, '甲');
    const b = failedFill(repos, '乙');
    const ask = failedAsk(repos)!;
    expect(takeOverFailedAsk(repos, ask.id, b.app.id)).toEqual([b.app.id]);
    expect(viewedApp()).toBe(b.app.id);
    expect(repos.getAction(b.action.id)!.status).toBe('needs_user');
    expect(repos.getApplication(b.app.id)!.stage).toBe('needs_user');
    expect(repos.openHandoffs()).toEqual([expect.objectContaining({ reason: 'user_request', action_id: b.action.id })]);
    const asks = asksFor(repos);
    expect(asks.find(x => x.kind === 'failed')).toMatchObject({ application_ids: [a.app.id] });
    expect(asks.find(x => x.kind === 'login')).toMatchObject({ application_ids: [b.app.id] });
    expect(() => takeOverFailedAsk(repos, 'act_gone')).toThrow(FailedAskError);
  });
});
