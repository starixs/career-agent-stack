import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import { activePage, bringToFront, findBrowserMainPid, fitPageViewport, maxParkedViewportHeight, PARK_DISPLAY_SIZE, parkedBoundsFor, parkWindow, PARKED_WINDOW_BOUNDS, restoreIfMinimized, viewportForFrame } from './page-control';
import { setVirtualParkTarget } from './virtual-display';

function fakePage(closed = false): Page {
  return {
    isClosed: () => closed,
    bringToFront: vi.fn(async () => {}),
    url: () => 'https://example.test',
  } as unknown as Page;
}

describe('activePage', () => {
  it('prefers the first live page and otherwise opens one', async () => {
    const live = fakePage();
    const fresh = fakePage();
    const context = {
      pages: vi.fn(() => [fakePage(true), live]),
      newPage: vi.fn(async () => fresh),
    } as unknown as BrowserContext;
    expect(await activePage(context)).toBe(live);

    vi.mocked(context.pages).mockReturnValue([fakePage(true)]);
    expect(await activePage(context)).toBe(fresh);
  });
});

describe('bringToFront', () => {
  it('restores the window over CDP and activates the Chrome app on macOS', async () => {
    const page = fakePage();
    const send = vi.fn(async (method: string) => (method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {}));
    const detach = vi.fn(async () => {});
    const context = {
      pages: () => [page],
      newCDPSession: vi.fn(async () => ({ send, detach })),
    } as unknown as BrowserContext;
    const activateApp = vi.fn(async () => {});

    await bringToFront(context, { channel: 'chrome', platform: 'darwin', activateApp, profileDir: '/p/ae7e' });

    expect(page.bringToFront).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Browser.getWindowForTarget');
    expect(send).toHaveBeenCalledWith('Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'normal' } });
    expect(detach).toHaveBeenCalledOnce();
    expect(activateApp).toHaveBeenCalledWith('chrome', '/p/ae7e');
  });

  it('findBrowserMainPid：只认带这个 profile 的托管 Chrome 主进程，不认子进程、不认用户自己的 Chrome', () => {
    const ps = [
      '  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '  202 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --no-first-run --user-data-dir=/Users/x/.keystone/browser-profile/ae7e --remote-debugging-pipe',
      '  203 /Applications/Google Chrome.app/.../Google Chrome Helper --type=renderer --user-data-dir=/Users/x/.keystone/browser-profile/ae7e',
      '  303 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/.keystone/browser-profile/ae7e-other',
    ].join('\n');
    expect(findBrowserMainPid(ps, '/Users/x/.keystone/browser-profile/ae7e')).toBe(202);
    expect(findBrowserMainPid(ps, '/Users/x/.keystone/browser-profile/nope')).toBeNull();
  });

  it('only logs when CDP or the OS activation fail, and skips osascript off macOS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const page = fakePage();
      const context = {
        pages: () => [page],
        newCDPSession: vi.fn(async () => { throw new Error('no cdp'); }),
      } as unknown as BrowserContext;
      const activateApp = vi.fn(async () => { throw new Error('osascript missing'); });

      await expect(bringToFront(context, { platform: 'darwin', activateApp })).resolves.toBe(page);
      expect(warn).toHaveBeenCalledTimes(2);

      activateApp.mockClear();
      await bringToFront(context, { platform: 'linux', activateApp });
      expect(activateApp).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('embedded window', () => {
  it('bringToFront 在内嵌模式下不切前台、不碰窗口、不激活应用', async () => {
    const page = fakePage();
    const newCDPSession = vi.fn();
    const activateApp = vi.fn(async () => {});
    const context = { pages: () => [page], newCDPSession } as unknown as BrowserContext;
    expect(await bringToFront(context, { embedded: true, platform: 'darwin', activateApp })).toBe(page);
    expect(page.bringToFront).not.toHaveBeenCalled();
    expect(newCDPSession).not.toHaveBeenCalled();
    expect(activateApp).not.toHaveBeenCalled();
  });

  it('parkWindow 先回 normal 再停到角落', async () => {
    const page = fakePage();
    const sent: Array<[string, unknown]> = [];
    const session = { send: vi.fn(async (method: string, params?: unknown) => { sent.push([method, params]); return method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {}; }), detach: vi.fn(async () => {}) };
    const context = { newCDPSession: vi.fn(async () => session) } as unknown as BrowserContext;
    expect(await parkWindow(context, page)).toBe(true);
    expect(sent).toEqual([
      ['Browser.getWindowForTarget', undefined],
      ['Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'normal' } }],
      ['Browser.setWindowBounds', { windowId: 7, bounds: { ...PARKED_WINDOW_BOUNDS } }],
      ['Browser.getWindowBounds', { windowId: 7 }],
    ]);
    expect(session.detach).toHaveBeenCalled();
  });
});

describe('live viewport', () => {
  it('停靠窗口不缩小到装不下视口（窗口比视口小时 screencast 比例会错）', () => {
    expect(PARKED_WINDOW_BOUNDS.width).toBeGreaterThanOrEqual(1366 + 40);
    expect(PARKED_WINDOW_BOUNDS.height).toBeGreaterThanOrEqual(768 + 160);
  });

  it('画面框 → 视口：宽度固定桌面版，高度按比例并夹在合理范围；停靠窗口按视口放大', () => {
    expect(viewportForFrame({ width: 683, height: 500 })).toEqual({ width: 1366, height: 1000 });
    expect(viewportForFrame({ width: 1200, height: 300 })).toEqual({ width: 1366, height: 600 });
    expect(viewportForFrame({ width: 300, height: 1200 })).toEqual({ width: 1366, height: 1500 });
    expect(viewportForFrame({ width: 10, height: 10 })).toBeNull();
    expect(parkedBoundsFor({ width: 1366, height: 1500 })).toMatchObject({ left: PARKED_WINDOW_BOUNDS.left, top: PARKED_WINDOW_BOUNDS.top, width: 1440, height: 1660 });
    expect(parkedBoundsFor(null)).toEqual({ ...PARKED_WINDOW_BOUNDS });
  });

  it('fitPageViewport 改视口并（内嵌时）把停靠窗口放大；视口没变就不重设', async () => {
    let vp: { width: number; height: number } | null = { width: 1366, height: 768 };
    const page = { ...fakePage(), isClosed: () => false, viewportSize: () => vp, setViewportSize: vi.fn(async (v: { width: number; height: number }) => { vp = v; }) } as unknown as Page;
    const sent: Array<[string, unknown]> = [];
    const session = { send: vi.fn(async (method: string, params?: unknown) => { sent.push([method, params]); return method === 'Browser.getWindowForTarget' ? { windowId: 9 } : {}; }), detach: vi.fn(async () => {}) };
    const context = { newCDPSession: vi.fn(async () => session) } as unknown as BrowserContext;
    expect(await fitPageViewport(context, page, { width: 1366, height: 1000 }, { park: true })).toBe(true);
    expect(vp).toEqual({ width: 1366, height: 1000 });
    expect(sent.at(-2)).toEqual(['Browser.setWindowBounds', { windowId: 9, bounds: parkedBoundsFor({ width: 1366, height: 1000 }) }]);
    sent.length = 0;
    expect(await fitPageViewport(context, page, { width: 1366, height: 1001 })).toBe(false);
    expect(sent).toEqual([]);
  });

  it('系统把停靠窗口压矮了（屏幕不够高）：视口按实际窗口高度收，不让实时帧只拍到半截', async () => {
    let vp: { width: number; height: number } | null = { width: 1366, height: 768 };
    const page = { ...fakePage(), isClosed: () => false, viewportSize: () => vp, setViewportSize: vi.fn(async (v: { width: number; height: number }) => { vp = v; }) } as unknown as Page;
    const session = { send: vi.fn(async (method: string) => method === 'Browser.getWindowForTarget' ? { windowId: 9 } : method === 'Browser.getWindowBounds' ? { bounds: { width: 1440, height: 900 } } : {}), detach: vi.fn(async () => {}) };
    const context = { newCDPSession: vi.fn(async () => session) } as unknown as BrowserContext;
    await fitPageViewport(context, page, { width: 1366, height: 1100 }, { park: true });
    expect(vp).toEqual({ width: 1366, height: 900 - 160 });
  });
});

describe('restoreIfMinimized', () => {
  const contextWith = (windowState: string) => {
    const send = vi.fn(async (method: string) => (method === 'Browser.getWindowForTarget' ? { windowId: 3, bounds: { windowState } } : {}));
    const detach = vi.fn(async () => {});
    return { send, detach, context: { newCDPSession: vi.fn(async () => ({ send, detach })) } as unknown as BrowserContext };
  };

  it('restores a minimized window to normal without moving it', async () => {
    const { send, detach, context } = contextWith('minimized');
    expect(await restoreIfMinimized(context, fakePage())).toBe(true);
    expect(send).toHaveBeenCalledWith('Browser.setWindowBounds', { windowId: 3, bounds: { windowState: 'normal' } });
    expect(detach).toHaveBeenCalledOnce();
  });

  it('leaves a visible or parked window alone', async () => {
    const { send, context } = contextWith('normal');
    expect(await restoreIfMinimized(context, fakePage())).toBe(false);
    expect(send).not.toHaveBeenCalledWith('Browser.setWindowBounds', expect.anything());
  });

  it('only logs when CDP is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const context = { newCDPSession: vi.fn(async () => { throw new Error('no cdp'); }) } as unknown as BrowserContext;
      expect(await restoreIfMinimized(context, fakePage())).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('parked viewport fits its screen', () => {
  it('caps the viewport at what a window on the virtual display can show, and sizes that display for the tallest viewport', () => {
    // 1366×768 的虚拟屏：窗口最多 768 高，视口超过约 608 就会被压矮——实时帧和截图对不上
    setVirtualParkTarget({ displayID: 1, x: -1366, y: -768, w: 1366, h: 768 });
    expect(maxParkedViewportHeight()).toBe(768 - 160);
    setVirtualParkTarget(null);
    expect(maxParkedViewportHeight()).toBe(1500);
    // 现在建的虚拟屏能装下最高的视口
    expect(PARK_DISPLAY_SIZE.height - 160).toBeGreaterThanOrEqual(viewportForFrame({ width: 100, height: 1000 })!.height);
  });
});
