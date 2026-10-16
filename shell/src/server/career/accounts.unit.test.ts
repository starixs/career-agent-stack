import { describe, expect, it } from 'vitest';

import { clearAccountFetch, isAccountField, listAccountFetch, reportAccountFetch, requestAccountFetch } from './accounts';

function memoryKv() {
  const store = new Map<string, unknown>();
  return {
    kvGet: <T>(key: string) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) as T : undefined),
    kvSet: (key: string, value: unknown) => { store.set(key, value); },
  };
}

describe('绑定账号抓取状态', () => {
  it('请求 → 抓到：记下抓取时间', () => {
    const kv = memoryKv();
    requestAccountFetch(kv, 'linkedin', '2026-10-16T01:00:00.000Z');
    expect(listAccountFetch(kv).linkedin).toEqual({ status: 'requested', requested_at: '2026-10-16T01:00:00.000Z', fetched_at: null, note: null });
    reportAccountFetch(kv, 'linkedin', 'ok', '拿到 3 段经历', '2026-10-16T01:05:00.000Z');
    expect(listAccountFetch(kv).linkedin).toMatchObject({ status: 'ok', fetched_at: '2026-10-16T01:05:00.000Z', note: '拿到 3 段经历' });
  });

  it('登录过期：保留上一次成功的时间；再次请求时也保留', () => {
    const kv = memoryKv();
    reportAccountFetch(kv, 'maimai', 'ok', null, '2026-10-01T00:00:00.000Z');
    reportAccountFetch(kv, 'maimai', 'login_expired', '打开是登录页', '2026-10-16T00:00:00.000Z');
    expect(listAccountFetch(kv).maimai).toMatchObject({ status: 'login_expired', fetched_at: '2026-10-01T00:00:00.000Z' });
    requestAccountFetch(kv, 'maimai', '2026-10-16T02:00:00.000Z');
    expect(listAccountFetch(kv).maimai).toMatchObject({ status: 'requested', fetched_at: '2026-10-01T00:00:00.000Z', note: null });
  });

  it('解绑清掉状态，不影响别的账号；只认已知账号', () => {
    const kv = memoryKv();
    requestAccountFetch(kv, 'github');
    requestAccountFetch(kv, 'chsi');
    clearAccountFetch(kv, 'github');
    expect(Object.keys(listAccountFetch(kv))).toEqual(['chsi']);
    expect(isAccountField('github')).toBe(true);
    expect(isAccountField('xiaohongshu')).toBe(false);
  });
});
