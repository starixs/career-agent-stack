/**
 * 现场窗交还只交他眼前这一家（2026-11-03 用户：哪家要你接手就在那家接手，不是一批下来全有问题）。
 */
import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { handoffsToHandBack, waitingByApp } from './live-handback';
import { createMemoryRepos } from './test-db';

function waiting(repos: Repos, company: string, reason: 'login' | 'captcha' = 'login') {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: company, title: '数据分析', company_name: company });
  const app = repos.createApplication(job.id);
  const a = repos.enqueueAction('fill_form', { url: `https://jobs.${company}.com/apply/1` }, app.id, true);
  return { app, handoff: repos.openHandoff(reason, { actionId: a.id }) };
}

describe('交还哪几家', () => {
  it('他正看着中车：只交还中车，美团、小米还在等他', () => {
    const repos = createMemoryRepos();
    const crrc = waiting(repos, 'crrc'); waiting(repos, 'meituan'); waiting(repos, 'xiaomi', 'captcha');
    expect(handoffsToHandBack(repos, { appKey: crrc.app.id }).map(h => h.id)).toEqual([crrc.handoff.id]);
  });

  it('登录之旅钉住的那家优先', () => {
    const repos = createMemoryRepos();
    waiting(repos, 'crrc'); const mt = waiting(repos, 'meituan');
    expect(handoffsToHandBack(repos, { pinnedHandoffId: mt.handoff.id }).map(h => h.id)).toEqual([mt.handoff.id]);
  });

  it('看不出在看哪家：只有一家在等就是它；好几家在等就一家都不动', () => {
    const repos = createMemoryRepos();
    const one = waiting(repos, 'crrc');
    expect(handoffsToHandBack(repos, {}).map(h => h.id)).toEqual([one.handoff.id]);
    waiting(repos, 'meituan');
    expect(handoffsToHandBack(repos, {})).toEqual([]);
  });

  it('现场窗小签：每家在等什么', () => {
    const repos = createMemoryRepos();
    const crrc = waiting(repos, 'crrc'); const mi = waiting(repos, 'xiaomi', 'captcha');
    expect(Object.fromEntries(waitingByApp(repos))).toEqual({ [crrc.app.id]: 'login', [mi.app.id]: 'captcha' });
  });
});
