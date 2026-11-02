import { describe, expect, it, vi } from 'vitest';

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

  it('页面跳转途中上下文被销毁：等新文档到了再执行一次（Bing 重定向时实测会抛）', async () => {
    let calls = 0;
    const waitForLoadState = vi.fn(async () => {});
    const page = { evaluate: async () => { calls += 1; if (calls === 1) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'); return 7; }, waitForLoadState };
    await expect(inPage(page as never, () => 0, null)).resolves.toBe(7);
    expect(waitForLoadState).toHaveBeenCalledWith('domcontentloaded', expect.anything());
  });

  it('别的错误照常抛出，不重试', async () => {
    const page = { evaluate: async () => { throw new Error('ReferenceError: x is not defined'); }, waitForLoadState: vi.fn() };
    await expect(inPage(page as never, () => 0, null)).rejects.toThrow('ReferenceError');
    expect(page.waitForLoadState).not.toHaveBeenCalled();
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

  it('扫码后的「绑定手机号」中间页、还在 /login/ 路径下的页 → 仍是 login（没登完，不能放行）', () => {
    expect(detectHints({ hasPassword: false, bodySample: '绑定手机号/邮箱 绑定手机号 绑定邮箱', url: 'https://mediatek.zhiye.com/login/bindMobile' }, [])).toEqual(['login']);
    expect(detectHints({ hasPassword: false, bodySample: '欢迎', url: 'https://x.com/passport/next' }, [])).toEqual(['login']);
    expect(detectHints({ hasPassword: false, bodySample: '我的投递', url: 'https://x.com/campus/jobs' }, [])).toEqual([]);
  });

  it('美团登录框勾了隐私协议之后（「扫码登录」换成「微信快捷登录」）→ 仍是 login，不能当成登上了（2026-11-02 实测）', () => {
    const meituan = '智能商业分析师（BA/DS） 美团·招聘 手机登录 +86 15500001234 获取验证码 立即登录 小明 微信快捷登录 使用其他头像、昵称或账号 我已阅读并同意《个人信息保护隐私政策》';
    expect(detectHints({ hasPassword: false, bodySample: meituan, url: 'https://zhaopin.meituan.com/web/position/detail' }, [])).toEqual(['login']);
    // 登上以后导航栏只有「我的投递」，没有登录框
    expect(detectHints({ hasPassword: false, bodySample: '智能商业分析师（BA/DS） 立即申请 我的投递', url: 'https://zhaopin.meituan.com/web/position/detail' }, [])).toEqual([]);
  });

  it('搜狗这类反爬页（「需要您协助验证」+ antispider 地址）→ captcha + risk，不再只报 submit_page', () => {
    const raw = { hasPassword: false, bodySample: '此验证码用于确认这些请求是您的正常行为而不是自动程序发出的，需要您协助验证。', url: 'https://weixin.sogou.com/antispider/?from=x' };
    expect(detectHints(raw, [el({ text: '提交', submitLike: true })])).toEqual(['captcha', 'risk', 'submit_page']);
  });
});

describe('navigateWithRetry', () => {
  type GotoMock = (url: string, opts?: Record<string, unknown>) => Promise<void>;
  const fakePage = (impl: GotoMock, currentUrl: string) => {
    let url = currentUrl;
    const setUrl = (u: string) => { url = u; };
    const page = {
      url: () => url,
      goto: async (u: string, o?: Record<string, unknown>) => { await impl(u, o); url = u; },
    };
    return { page: page as never as import('playwright').Page, setUrl };
  };
  const timeoutError = () => new Error('Timeout 20000ms exceeded.');

  it('第一次成功：只调一次 goto', async () => {
    const calls: string[] = [];
    const { page } = fakePage(async u => { calls.push(u); }, 'about:blank');
    const { navigateWithRetry } = await import('./browse');
    await navigateWithRetry(page, 'https://job.example.com/apply');
    expect(calls).toEqual(['https://job.example.com/apply']);
  });

  it('第一次超时但地址栏已到达目标：不重试，视为成功', async () => {
    const calls: string[] = [];
    // 模拟"超时发生在 load 阶段、页面其实到了"：goto 抛超时，但地址栏已在目标上
    const { page, setUrl } = fakePage(async u => { calls.push(u); setUrl(u); throw timeoutError(); }, 'about:blank');
    const { navigateWithRetry } = await import('./browse');
    await expect(navigateWithRetry(page, 'https://job.example.com/apply')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('第一次超时且未到达：等 1.5s 后用 45s 重试，第二次成功', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const { page } = fakePage(async (_u, o) => {
        attempt += 1;
        if (attempt === 1) throw timeoutError();
        expect(o).toMatchObject({ timeout: 45_000, waitUntil: 'domcontentloaded' });
      }, 'about:blank');
      const { navigateWithRetry } = await import('./browse');
      const settled = navigateWithRetry(page, 'https://job.example.com/apply').then(() => 'done', () => 'failed');
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(settled).resolves.toBe('done');
      expect(attempt).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('两次都失败：抛带行动指引的错误（不要直接放弃）', async () => {
    vi.useFakeTimers();
    try {
      const { page } = fakePage(async () => { throw timeoutError(); }, 'about:blank');
      const { navigateWithRetry } = await import('./browse');
      const settled = navigateWithRetry(page, 'https://slow.example.com/apply').then(() => 'done', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1_500);
      const message = await settled;
      expect(message).toContain('两次尝试均超时');
      expect(message).toContain('browser_observe');
    } finally {
      vi.useRealTimers();
    }
  });

  it('DNS / 网络层错误：指引核对链接与用户网络', async () => {
    vi.useFakeTimers();
    try {
      const { page } = fakePage(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED at https://x.com'); }, 'about:blank');
      const { navigateWithRetry } = await import('./browse');
      const settled = navigateWithRetry(page, 'https://x.com').then(() => 'done', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1_500);
      const message = await settled;
      expect(message).toContain('ERR_NAME_NOT_RESOLVED');
      expect(message).toContain('核对链接');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('动作期间新开的标签页只认自己打开的', () => {
  it('别的网申同时开的页面（opener 不是这一页）不算这次点出来的新标签；关掉的也不算', async () => {
    const { openedBy } = await import('./browse');
    const me = { tag: 'me' } as unknown as import('playwright').Page;
    const fake = (opener: unknown, closed = false) => ({ isClosed: () => closed, opener: async () => opener }) as unknown as import('playwright').Page;
    const popup = fake(me);
    const otherRun = fake(null);
    const closedPopup = fake(me, true);
    expect(await openedBy(me, [otherRun, popup, closedPopup])).toEqual([popup]);
  });
});
