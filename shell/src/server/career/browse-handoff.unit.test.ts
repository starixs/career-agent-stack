/**
 * 对话里浏览时请人登录（waitForUser）：先看数据层——网站发下了新的会话凭证就算登上，哪怕页面角落还留着「扫码登录」字样；
 * 画面提示只作辅助（用户 2026-10-30）。
 */
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';

import { waitForUser } from './browse-handoff';

/** 页面一直像登录页（有密码框、写着扫码登录）。 */
const loginLookingPage = { isClosed: () => false, url: () => 'https://a.com/login', evaluate: async () => ({ url: 'https://a.com/login', hasPassword: true, bodySample: '扫码登录 请登录' }) } as unknown as Page;

describe('waitForUser 等登录', () => {
  it('新会话凭证一出现就算登上（signal=credentials），不管页面上还有没有登录字样', async () => {
    let n = 0;
    const out = await waitForUser(loginLookingPage, { blocking: ['login'], timeoutMs: 1000, pollMs: 1, sleep: async () => undefined, credentials: async () => (++n >= 3 ? ['sid'] : []) });
    expect(out).toMatchObject({ status: 'done', signal: 'credentials', credentials: ['sid'] });
  });

  it('没给数据层判断时照旧看画面：登录字样一直在就等到超时', async () => {
    let t = 0;
    const out = await waitForUser(loginLookingPage, { blocking: ['login'], timeoutMs: 30, pollMs: 1, sleep: async () => { t += 10; }, now: () => t });
    expect(out.status).toBe('timeout');
  });
});
