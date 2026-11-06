import { afterEach, describe, expect, it } from 'vitest';

import { adoptApplicationPage, resetApplicationPages } from './app-pages';
import { releaseClearedCaptchas } from './captcha-watch';
import { createMemoryRepos } from './test-db';

const page = () => { const frame = {}; return { url: () => 'https://x.com/apply', isClosed: () => false, mainFrame: () => frame, once: () => {} }; };

describe('等他过验证码：验证码没了就自动交还接着填（2026-11-06「填完之后然后去下一步」）', () => {
  afterEach(() => resetApplicationPages());

  function setup() {
    const repos = createMemoryRepos();
    const app = repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: 'tx', title: '算法', company_name: '腾讯' }).id).id;
    const fill = repos.enqueueAction('fill_form', {}, app, true);
    repos.setActionStatus(fill.id, 'needs_user');
    const h = repos.openHandoff('captcha', { actionId: fill.id, message: '拖动滑块' });
    const p = page();
    adoptApplicationPage('sess', app, p as never);
    const withContext = <T,>(fn: (ctx: never) => Promise<T>) => fn({ pages: () => [p] } as never);
    return { repos, h, withContext, later: () => Date.parse(h.paused_at) + 5000 };
  }

  it('验证码还在：不动；没了：关掉接管，批量运行器从当前页接着填', async () => {
    const { repos, h, withContext, later } = setup();
    let there = true;
    const deps = { repos, sessionId: 'sess', withContext, probe: { stillThere: async () => there }, now: later };
    expect(await releaseClearedCaptchas(deps)).toEqual([]);
    expect(repos.openHandoffs()).toHaveLength(1);
    there = false;
    expect(await releaseClearedCaptchas(deps)).toEqual([h.id]);
    expect(repos.openHandoffs()).toHaveLength(0);
  });

  it('刚弹出来的几秒不看（验证码可能还没画出来）；看不了这一页就当还在', async () => {
    const { repos, withContext, h } = setup();
    expect(await releaseClearedCaptchas({ repos, sessionId: 'sess', withContext, probe: { stillThere: async () => false }, now: () => Date.parse(h.paused_at) + 500 })).toEqual([]);
    expect(await releaseClearedCaptchas({ repos, sessionId: 'sess', withContext, probe: { stillThere: async () => { throw new Error('页面在跳转'); } }, now: () => Date.parse(h.paused_at) + 5000 })).toEqual([]);
    expect(repos.openHandoffs()).toHaveLength(1);
  });
});
