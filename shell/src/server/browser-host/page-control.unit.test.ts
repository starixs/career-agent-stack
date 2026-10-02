import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import { activePage, bringToFront } from './page-control';

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
