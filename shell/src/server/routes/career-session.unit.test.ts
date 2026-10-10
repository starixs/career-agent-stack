import { describe, expect, it } from 'vitest';

import { BATCH_COMMAND_KEY } from '../career/batch-runner';
import { createMemoryRepos } from '../career/test-db';
import { handleCareerSessionRoute } from './career-session';

async function review(deps: Parameters<typeof handleCareerSessionRoute>[2], actionIds: string[], decision: string) {
  const request = new Request('http://local/api/career-session/review', { method: 'POST', body: JSON.stringify({ actionIds, decision }), headers: { 'Content-Type': 'application/json' } });
  const response = await handleCareerSessionRoute('/api/career-session/review', request, deps);
  return { status: response!.status, json: await response!.json() as Record<string, unknown> };
}

describe('career-session review', () => {
  it('对话里批准填表：只落审批，执行交给助理（apply_run），不再让后台运行器抢同一份', async () => {
    const repos = createMemoryRepos();
    const events: string[] = [];
    const fill = repos.enqueueAction('fill_form', { job_id: 'job_1', url: 'https://zhaopin.meituan.com/x' });
    const res = await review({ repos, broadcast: e => { events.push(e); }, sessionId: () => 's1' }, [fill.id], 'approved');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ n: 1 });
    expect(repos.getAction(fill.id)?.status).toBe('approved');
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeFalsy();
    expect(events).toContain('career:data-changed');
  });

  it('拒绝提交：动作置为 rejected', async () => {
    const repos = createMemoryRepos();
    const submit = repos.enqueueAction('submit', { url: 'https://x' });
    const res = await review({ repos, broadcast: () => {}, sessionId: () => 's1' }, [submit.id], 'rejected');
    expect(res.json).toMatchObject({ n: 1 });
    expect(repos.getAction(submit.id)?.status).toBe('rejected');
  });
});
