/**
 * 登录收码走配置过的来源（verification.json 模板）：没开 / 没模板 → null（调用方用通用取码或请他填）；
 * 有模板 → 发码前打开通道，码到了直接用；等不到就到点放弃，不挂住登录之旅。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Repos } from '@career/core';

const config = vi.hoisted(() => ({ value: { enabled: false, captcha: true, timeoutMs: 90_000, templates: [] as unknown[] } }));
const prepared = vi.hoisted(() => ({ wait: vi.fn<(since: number) => Promise<string | null>>(), close: vi.fn(async () => undefined), calls: [] as unknown[][] }));

vi.mock('./verification-config', () => ({
  loadVerificationConfig: async () => config.value,
  templateFor: (c: { templates: Array<{ origin: string }> }, url: string) => c.templates.find(t => new URL(url).origin === t.origin),
}));
vi.mock('./verification-source', () => ({
  prepareCodeSource: async (...args: unknown[]) => { prepared.calls.push(args); return { wait: prepared.wait, close: prepared.close }; },
  acquireCodeLease: async () => () => undefined,
}));
const phone = vi.hoisted(() => ({ connected: true, waits: [] as unknown[] }));
vi.mock('./phone', () => ({
  phoneLink: async () => ({
    ensureConnected: async () => phone.connected,
    waitForCode: async (opts: unknown) => { phone.waits.push(opts); return { code: '654321' }; },
  }),
}));

import { openLoginCodeSource, openPhoneCodeSource } from './login-code-source';

const repos = {} as Repos;
const sms = { id: 'crrc-sms', origin: 'https://crrc.hotjob.cn', channel: 'sms' };

describe('openLoginCodeSource', () => {
  afterEach(() => { config.value = { enabled: false, captcha: true, timeoutMs: 90_000, templates: [] }; prepared.calls = []; prepared.wait.mockReset(); });

  it('没开自动收码、或这家没模板、或渠道不对：返回 null，不打开任何通道', async () => {
    expect(await openLoginCodeSource(repos, 'https://crrc.hotjob.cn/a', 'sms', '15500001234')).toBeNull();
    config.value = { ...config.value, enabled: true, templates: [sms] };
    expect(await openLoginCodeSource(repos, 'https://other.com/a', 'sms', '15500001234')).toBeNull();
    expect(await openLoginCodeSource(repos, 'https://crrc.hotjob.cn/a', 'email', 'a@163.com')).toBeNull();
    expect(prepared.calls).toHaveLength(0);
  });

  it('有短信模板：发码前就打开手机通道，读到的码原样交回', async () => {
    config.value = { ...config.value, enabled: true, templates: [sms] };
    prepared.wait.mockResolvedValue('483920');
    const source = await openLoginCodeSource(repos, 'https://crrc.hotjob.cn/a', 'sms', '15500001234');
    expect(prepared.calls[0]?.[2]).toBe('15500001234');
    expect(await source?.wait(Date.now(), 1000)).toBe('483920');
    await source?.close();
    expect(prepared.close).toHaveBeenCalled();
  });

  it('等不到码：到点取消通道，返回 null，不一直挂着', async () => {
    config.value = { ...config.value, enabled: true, templates: [sms] };
    const signal = () => prepared.calls[0]?.[3] as AbortSignal;
    prepared.wait.mockImplementation(() => new Promise((_, reject) => { signal().addEventListener('abort', () => reject(new Error('aborted'))); }));
    const source = await openLoginCodeSource(repos, 'https://crrc.hotjob.cn/a', 'sms', '15500001234');
    expect(await source?.wait(Date.now(), 20)).toBeNull();
  });
});

describe('openPhoneCodeSource', () => {
  it('没配模板：从连着的手机读「发码之后到的那一条」，不要求签名（2026-11-05）', async () => {
    phone.connected = true; phone.waits = [];
    const source = await openPhoneCodeSource();
    expect(await source?.wait(1000, 120_000)).toBe('654321');
    expect(phone.waits[0]).toMatchObject({ since: 1000, timeoutMs: 120_000 });
    expect(phone.waits[0]).not.toHaveProperty('strict', true);
    await source?.close();
  });
  it('手机没连上：返回 null，调用方再请他填', async () => {
    phone.connected = false;
    expect(await openPhoneCodeSource()).toBeNull();
  });
});
