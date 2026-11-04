/**
 * 听登录接口返回：Playwright 的响应有 headers / text；真实 Chrome 桥接的被动响应只有 json（2026-11-04 合入 main）。
 * 两种都要读得出登录成功没有，不能因为少了 headers 就报错、让登录判断少一路。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';

import { onLoginResponse, responseBody } from './login-watch';

describe('responseBody', () => {
  it('Playwright 响应：按 content-type 读正文', async () => {
    expect(await responseBody({ url: () => 'https://a.com/api/login', status: () => 200, headers: () => ({ 'content-type': 'application/json' }), text: async () => '{"code":0}' })).toBe('{"code":0}');
  });
  it('桥接的被动响应只有 json：照样读出来', async () => {
    expect(await responseBody({ url: () => 'https://a.com/api/login', status: () => 200, json: async () => ({ success: true }) })).toBe('{"success":true}');
  });
});

describe('onLoginResponse', () => {
  it('只读登录接口的返回体；别的请求连 json 都不读（桥接下读正文要多发一次请求）', async () => {
    let handler: ((r: unknown) => void) | undefined;
    const page = { on: (_: string, cb: (r: unknown) => void) => { handler = cb; }, off: () => undefined } as unknown as Page;
    const verdicts: string[] = [];
    onLoginResponse(page, v => verdicts.push(String(v)));
    const pictureJson = vi.fn(async () => ({}));
    handler?.({ url: () => 'https://a.com/static/banner.png', status: () => 200, json: pictureJson });
    handler?.({ url: () => 'https://a.com/passport/login', status: () => 200, json: async () => ({ success: true }) });
    await vi.waitFor(() => expect(verdicts).toEqual(['ok']));
    expect(pictureJson).not.toHaveBeenCalled();
  });
});
