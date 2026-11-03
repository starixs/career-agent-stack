import { describe, expect, it } from 'vitest';

import { classifyMailError, verifyMailCredentials } from './verify';

const target = { address: 'me@qq.com', password: 'abcdefghijklmnop', imap_host: 'imap.qq.com', imap_port: 993, smtp_host: 'smtp.qq.com', smtp_port: 465 };

describe('classifyMailError', () => {
  it('按原因分类：授权码错、网易风控、没开 IMAP、网络不通', () => {
    expect(classifyMailError(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Login fail. Account is abnormal' })).code).toBe('imap_auth_failed');
    expect(classifyMailError(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Unsafe Login. Please contact kefu@188.com' })).code).toBe('provider_blocked');
    expect(classifyMailError(new Error('IMAP service is not enabled for this account')).code).toBe('imap_disabled');
    expect(classifyMailError(new Error('connect ECONNREFUSED 1.2.3.4:993')).code).toBe('unreachable');
  });
});

describe('verifyMailCredentials', () => {
  it('收信、发信都过；发信没过也算连上并标出来', async () => {
    expect(await verifyMailCredentials(target, { imap: async () => ({ uidvalidity: 7 }), smtp: async () => undefined })).toEqual({ ok: true, uidvalidity: 7, smtp_ok: true });
    const partial = await verifyMailCredentials(target, { imap: async () => ({ uidvalidity: 7 }), smtp: async () => { throw new Error('535 auth'); } });
    expect(partial).toMatchObject({ ok: true, smtp_ok: false });
  });

  it('服务器不回话时按时限结束，算网络不通', async () => {
    const res = await verifyMailCredentials(target, { imap: () => new Promise(() => undefined), timeoutMs: 20 });
    expect(res).toMatchObject({ ok: false, error_code: 'unreachable' });
  });
});
