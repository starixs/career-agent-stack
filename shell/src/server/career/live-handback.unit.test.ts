/**
 * 现场窗交还只交他眼前这一家（2026-11-03 用户：哪家要你接手就在那家接手，不是一批下来全有问题）。
 */
import { describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { handoffsToHandBack, recheckAfterHandback, waitingByApp } from './live-handback';
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

describe('交还时眼前这家已经填好、在等投前过目（2026-11-05 滴滴：他点到了确认提交页，交还后没人看）', () => {
  it('作废旧的过目，把填表以「接管后续跑」放回：批量运行器会从当前页重新看一遍', () => {
    const repos = createMemoryRepos();
    const app = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: 'dd', title: '数据分析', company_name: '滴滴' }).id).id;
    const fill = repos.enqueueAction('fill_form', {}, app, true);
    repos.setActionStatus(fill.id, 'done');
    const submit = repos.enqueueAction('submit', { submitButton: '预览并提交' }, app);
    expect(recheckAfterHandback(repos, app)).toBe(fill.id);
    expect(repos.getAction(submit.id)!.status).toBe('rejected');
    expect(repos.getAction(fill.id)!.status).toBe('executing');
    const resumable = repos.db.all<{ id: string }>(`SELECT a.id FROM action_queue a JOIN handoff h ON h.action_id=a.id WHERE a.status IN ('needs_user','executing') AND h.resumed_at IS NOT NULL`);
    expect(resumable.map(r => r.id)).toEqual([fill.id]);
    expect(recheckAfterHandback(repos, app)).toBeNull();
  });
});
