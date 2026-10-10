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
  it('批准填表即交给后台运行器：只填这一份（run 命令）（模型那一轮已经结束，不能等它调 apply_run）', async () => {
    const repos = createMemoryRepos();
    const events: string[] = [];
    const fill = repos.enqueueAction('fill_form', { job_id: 'job_1', url: 'https://zhaopin.meituan.com/x' });
    const res = await review({ repos, broadcast: e => { events.push(e); }, sessionId: () => 's1' }, [fill.id], 'approved');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ n: 1, filling: [fill.id] });
    expect(repos.getAction(fill.id)?.status).toBe('approved');
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toMatchObject({ cmd: 'run', by: 'approval', ids: [fill.id] });
    expect(events).toContain('career:data-changed');
  });

  it('拒绝 / 非填表动作 / 已审过的动作不启动运行器', async () => {
    const repos = createMemoryRepos();
    const deps = { repos, broadcast: () => {}, sessionId: () => 's1' };
    const fill = repos.enqueueAction('fill_form', { job_id: 'job_1' });
    await review(deps, [fill.id], 'rejected');
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeFalsy();

    const submit = repos.enqueueAction('submit', { url: 'https://x' });
    const res = await review(deps, [submit.id], 'approved');
    expect(res.json.filling).toEqual([]);
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeFalsy();

    const again = await review(deps, [fill.id], 'approved');
    expect(again.json.filling).toEqual([]);
    expect(repos.kvGet(BATCH_COMMAND_KEY)).toBeFalsy();
  });
});
