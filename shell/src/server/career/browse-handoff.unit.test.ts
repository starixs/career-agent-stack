/**
 * 对话里浏览时请人登录（waitForUser）：数据层和画面两路一起看（用户 2026-10-30：要看数据层，不止看画面）。
 * 两路合起来的判断在 login-signal.LoginJudge（单测见 login-journey.unit.test.ts），这里测 waitForUser 怎么用它。
 */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';

import { waitForUser } from './browse-handoff';

/** 页面一直像登录页（有密码框、写着扫码登录）。 */
const loginLookingPage = { isClosed: () => false, url: () => 'https://a.com/login', evaluate: async () => ({ url: 'https://a.com/login', hasPassword: true, bodySample: '扫码登录 请登录' }) } as unknown as Page;

describe('waitForUser 等登录', () => {
  it('登录判断说登上了就结束（带上是哪一路判的），不管页面上还有没有登录字样', async () => {
    let n = 0;
    const login = async () => (++n >= 3 ? { state: 'logged_in' as const, signal: 'credentials' as const, credentials: ['sid'] } : { state: 'waiting' as const, credentials: [] });
    const out = await waitForUser(loginLookingPage, { blocking: ['login'], timeoutMs: 1000, pollMs: 1, sleep: async () => undefined, login });
    expect(out).toMatchObject({ status: 'done', signal: 'credentials', credentials: ['sid'] });
  });

  it('登录判断说失败（接口报错 / 画面报错）时，挡路的提示看起来没了也不算', async () => {
    let t = 0;
    const clearPage = { isClosed: () => false, url: () => 'https://a.com/home', evaluate: async () => ({ url: 'https://a.com/home', hasPassword: false, bodySample: '首页' }) } as unknown as Page;
    const out = await waitForUser(clearPage, { blocking: ['login'], timeoutMs: 30, pollMs: 1, sleep: async () => { t += 10; }, now: () => t, login: async () => ({ state: 'failed', credentials: [] }) });
    expect(out.status).toBe('timeout');
  });

  it('没给数据层判断时照旧看画面：登录字样一直在就等到超时', async () => {
    let t = 0;
    const out = await waitForUser(loginLookingPage, { blocking: ['login'], timeoutMs: 30, pollMs: 1, sleep: async () => { t += 10; }, now: () => t });
    expect(out.status).toBe('timeout');
  });
});
