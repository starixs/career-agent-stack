/**
 * jobs_apply 回执里的「现在已经在等他」：只算这批网申的，给准数和前几件标题。
 */
import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { waitingOnYou } from './batch-apply';
import { createMemoryRepos } from './test-db';

const NOW = '2026-11-05T10:00:00.000Z';

function stuck(repos: Repos, company: string, gap: string) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '后端', company_name: company });
  const app = repos.createApplication(job.id);
  const action = repos.enqueueAction('fill_form', {}, app.id, true);
  repos.openHandoff('missing_info', { actionId: action.id });
  repos.setActionStatus(action.id, 'needs_user', {
    needsUser: [{ label: gap }],
    gate: { gaps: [{ label: gap, status: 'needs_user', required: true }] },
  });
  return action;
}

describe('waitingOnYou', () => {
  it('counts only what this batch is waiting on', () => {
    const repos = createMemoryRepos();
    const mine = stuck(repos, '美团', '证件号码');
    stuck(repos, '京东', '证件号码');
    const out = waitingOnYou(repos, [mine.id], NOW);
    expect(out.count).toBe(1);
    expect(out.titles.length).toBe(1);
  });

  it('nothing waiting: zero, no titles', () => {
    const repos = createMemoryRepos();
    expect(waitingOnYou(repos, [], NOW)).toEqual({ count: 0, titles: [] });
    expect(waitingOnYou(repos, ['no_such_action'], NOW)).toEqual({ count: 0, titles: [] });
  });
});
