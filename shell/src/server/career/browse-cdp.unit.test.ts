import { describe, expect, it } from 'vitest';

import { cdpMethodAllowed, sanitizeCdpResult } from './browse-cdp';

// 模型直发 CDP（browser_cdp / browse action:'cdp'）的纯逻辑：白名单 + 大结果截断。

describe('cdpMethodAllowed', () => {
  it('只放行 Page / Input / DOM / Runtime / Emulation 五个域的单段方法名', () => {
    for (const m of ['Page.captureScreenshot', 'Input.dispatchMouseEvent', 'DOM.getDocument', 'Runtime.evaluate', 'Emulation.setDeviceMetricsOverride']) expect(cdpMethodAllowed(m)).toBe(true);
  });

  it('拒绝别的域、空值和带越界字符的名字', () => {
    for (const m of ['Target.attachToTarget', 'Network.setCookie', 'Browser.close', 'Fetch.enable', 'Storage.clearDataForOrigin', '', 'Page', 'Page.', 'Page.e$vil', 'page.captureScreenshot']) expect(cdpMethodAllowed(m)).toBe(false);
  });
});

describe('sanitizeCdpResult', () => {
  it('截掉超长字符串（截图 base64），其余结构原样保留', () => {
    const out = sanitizeCdpResult({ data: 'A'.repeat(2000), frameTree: { childFrames: [{ frame: { id: 'f1', url: 'https://x.example/captcha' } }] } }) as { data: string; frameTree: { childFrames: Array<{ frame: { id: string } }> } };
    expect(out.data).toBe('[2000 chars omitted]');
    expect(out.frameTree.childFrames[0].frame.id).toBe('f1');
  });

  it('数组和嵌套对象都处理，短字符串、数字、布尔不动', () => {
    const out = sanitizeCdpResult([{ result: 'B'.repeat(900), ok: true, n: 3 }]) as Array<{ result: string; ok: boolean; n: number }>;
    expect(out[0].result).toBe('[900 chars omitted]');
    expect(out[0].ok).toBe(true);
    expect(out[0].n).toBe(3);
  });

  it('null / undefined / 原始值不炸', () => {
    expect(sanitizeCdpResult(null)).toBeNull();
    expect(sanitizeCdpResult(7)).toBe(7);
    expect(sanitizeCdpResult(undefined)).toBeUndefined();
  });
});
