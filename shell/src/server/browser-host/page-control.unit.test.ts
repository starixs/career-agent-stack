import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import { activePage, bringToFront, parkWindow, PARKED_WINDOW_BOUNDS, restoreIfMinimized } from './page-control';

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

    await bringToFront(context, { channel: 'chrome', platform: 'darwin', activateApp });

    expect(page.bringToFront).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('Browser.getWindowForTarget');
    expect(send).toHaveBeenCalledWith('Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'normal' } });
    expect(detach).toHaveBeenCalledOnce();
    expect(activateApp).toHaveBeenCalledWith('chrome');
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
    ]);
    expect(session.detach).toHaveBeenCalled();
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
