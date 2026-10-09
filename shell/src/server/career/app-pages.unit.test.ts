import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import { lockPage, openApplicationKeys, pageForApplication, releaseApplicationPage, resetApplicationPages, unlockPage } from './app-pages';

// 每份网申一个页面：借用代理每次是新对象，按 mainFrame 找回同一页。

function fakeContext() {
  const pages: Array<Page & { _closed: boolean }> = [];
  const make = (url = 'about:blank') => {
    const frame = {};
    const listeners: Array<() => void> = [];
    const state = { closed: false };
    const p = {
      get _closed() { return state.closed; },
      mainFrame: () => frame,
      isClosed: () => state.closed,
      url: () => url,
      once: (_ev: string, fn: () => void) => { listeners.push(fn); },
      close: async () => { state.closed = true; listeners.forEach(fn => fn()); },
    } as unknown as Page & { _closed: boolean };
    pages.push(p);
    return p;
  };
  make('https://home');
  /** 每次"借用"返回包一层的新代理（模拟 borrowBrowserContext） */
  const borrow = () => ({
    pages: () => pages.filter(p => !p._closed).map(p => new Proxy(p, {})),
    newPage: async () => new Proxy(make(), {}),
  }) as unknown as BrowserContext;
  return { pages, borrow, make };
}

describe('app-pages', () => {
  beforeEach(() => resetApplicationPages());

  it('同一份网申跨借用拿到同一页；不同网申各开一页', async () => {
    const c = fakeContext();
    const a1 = await pageForApplication(c.borrow(), 's', 'app_a', 'start');
    const b1 = await pageForApplication(c.borrow(), 's', 'app_b', 'start');
    const a2 = await pageForApplication(c.borrow(), 's', 'app_a', 'submit');
    expect(a2.mainFrame()).toBe(a1.mainFrame());
    expect(b1.mainFrame()).not.toBe(a1.mainFrame());
    expect(openApplicationKeys('s').sort()).toEqual(['app_a', 'app_b']);
  });

  it('页面没了：提交报错（不在别的页上乱点），续填退回当前页', async () => {
    const c = fakeContext();
    const a = await pageForApplication(c.borrow(), 's', 'app_a', 'start');
    await c.pages.find(p => p.mainFrame() === a.mainFrame())!.close();
    await expect(pageForApplication(c.borrow(), 's', 'app_a', 'submit')).rejects.toThrow(/已经关闭/);
    const cont = await pageForApplication(c.borrow(), 's', 'app_b', 'continue');
    expect(cont.url()).toBe('https://home');
  });

  it('页面锁按页：同一页互斥，不同页互不阻塞', async () => {
    const c = fakeContext();
    const a = await pageForApplication(c.borrow(), 's', 'app_a', 'start');
    const b = await pageForApplication(c.borrow(), 's', 'app_b', 'start');
    const aAgain = await pageForApplication(c.borrow(), 's', 'app_a', 'continue');
    expect(lockPage(a, 'batch')).toBeNull();
    expect(lockPage(aAgain, 'chat')).toBe('batch');
    expect(lockPage(b, 'chat')).toBeNull();
    unlockPage(a, 'batch');
    expect(lockPage(aAgain, 'chat')).toBeNull();
  });

  it('释放：关掉这份网申的页，但至少留一页', async () => {
    const c = fakeContext();
    await pageForApplication(c.borrow(), 's', 'app_a', 'start');
    await releaseApplicationPage(c.borrow(), 's', 'app_a');
    expect(c.pages.filter(p => !p._closed)).toHaveLength(1);
    expect(openApplicationKeys('s')).toEqual([]);
  });
});
