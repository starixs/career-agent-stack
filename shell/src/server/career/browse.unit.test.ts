import { describe, expect, it } from 'vitest';

import { detectHints, inPage, type ElementInfo } from './browse';

// 模型浏览的纯逻辑（真实 Chrome 流程见 scripts/career-browse-smoke.mjs）。

describe('inPage', () => {
  it('给序列化的页面函数垫上 __name（tsx / esbuild 会插这个 helper，浏览器里没有）', async () => {
    let sent = '';
    const page = { evaluate: async (src: unknown) => { sent = String(src); return (0, eval)(sent); } };
    // 模拟编译产物：函数体里调用了 __name
    const fn = new Function('arg', 'const inner = __name(() => arg.n * 2, "inner"); return inner();') as (arg: { n: number }) => number;
    await expect(inPage(page as never, fn, { n: 21 })).resolves.toBe(42);
    expect(sent).toContain('const __name = (f) => f;');
  });
});

describe('detectHints', () => {
  const el = (over: Partial<ElementInfo> = {}): ElementInfo => ({ kind: 'button', text: '查看', submitLike: false, isPassword: false, disabled: false, ...over });
  it('登录框 / 扫码登录 → login；滑块验证 → captcha；访问过频 → risk；有提交类按钮 → submit_page', () => {
    expect(detectHints({ hasPassword: true, bodySample: '', url: 'https://a.com' }, [])).toEqual(['login']);
    expect(detectHints({ hasPassword: false, bodySample: '请使用微信扫码登录', url: 'https://a.com' }, [])).toEqual(['login']);
    expect(detectHints({ hasPassword: false, bodySample: '请拖动滑块完成安全验证', url: 'https://a.com' }, [])).toEqual(['captcha']);
    expect(detectHints({ hasPassword: false, bodySample: '您访问过于频繁', url: 'https://a.com' }, [])).toEqual(['risk']);
    expect(detectHints({ hasPassword: false, bodySample: '岗位详情', url: 'https://a.com' }, [el({ text: '立即投递', submitLike: true })])).toEqual(['submit_page']);
    expect(detectHints({ hasPassword: false, bodySample: '岗位详情', url: 'https://a.com' }, [el()])).toEqual([]);
  });
});
