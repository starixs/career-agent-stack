import { execFile } from 'child_process';

import type { BrowserContext, Page } from 'playwright';

import type { BrowserChannel } from './runtime-settings';

const MAC_ACTIVATE_TIMEOUT_MS = 3_000;

/**
 * 最近活动的 Page。借用代理的 `pages()` 把 MCP 当前选中的 Tab 排在首位，所以
 * 第一个未关闭的 Page 就是"用户 / Agent 正在看的那一页"；没有则新开一页。
 */
export async function activePage(context: BrowserContext): Promise<Page> {
  const live = context.pages().find(page => !page.isClosed());
  return live ?? context.newPage();
}

async function activateMacApp(channel: BrowserChannel): Promise<void> {
  const bundleId = channel === 'chrome' ? 'com.google.Chrome' : 'org.chromium.Chromium';
  await new Promise<void>((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', `tell application id "${bundleId}" to activate`],
      { timeout: MAC_ACTIVATE_TIMEOUT_MS },
      error => (error ? reject(error) : resolve()),
    );
  });
}

export interface BringToFrontOptions {
  channel?: BrowserChannel;
  platform?: NodeJS.Platform;
  /** 可替换的 OS 级激活（测试注入）。 */
  activateApp?: (channel: BrowserChannel) => Promise<void>;
  /**
   * 内嵌窗口模式：用户在产品内的现场画面里操作，不能把真实 Chrome 拉到前面打断心流。
   * 只返回当前页，不切前台、不恢复窗口、不激活应用。
   */
  embedded?: boolean;
}

/**
 * 内嵌模式下窗口停靠的位置：极远的左下角，macOS 会夹回屏幕内只露出一小角。
 * 停靠只改位置、不缩小：窗口比页面视口（1366×768）还小时，Chrome 的 screencast 按窗口尺寸出帧，
 * 现场画面一打开比例就是错的，要等用户"显示真实窗口"放大一次才正常。
 */
export const PARKED_WINDOW_BOUNDS = { left: -10000, top: 10000, width: 1440, height: 1000 } as const;
/** 页面视口的固定宽度（桌面版布局）；高度按现场画面框的比例跟随。 */
export const LIVE_VIEWPORT_WIDTH = 1366;
const LIVE_VIEWPORT_MIN_HEIGHT = 600;
const LIVE_VIEWPORT_MAX_HEIGHT = 1500;
/** 窗口外框（标签栏、地址栏、边框）比视口多出来的大致尺寸。 */
const WINDOW_CHROME = { width: 40, height: 160 } as const;

export interface ViewportSize { width: number; height: number }

/** 现场画面框（CSS 像素）→ 页面视口：宽度固定，高度按画面框的宽高比，夹在合理范围里。 */
export function viewportForFrame(box: ViewportSize, width = LIVE_VIEWPORT_WIDTH): ViewportSize | null {
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width < 50 || box.height < 50) return null;
  const height = Math.round(width * (box.height / box.width));
  return { width, height: Math.min(LIVE_VIEWPORT_MAX_HEIGHT, Math.max(LIVE_VIEWPORT_MIN_HEIGHT, height)) };
}

/** 停靠窗口的尺寸：至少能装下视口，不小于缺省停靠尺寸。 */
export function parkedBoundsFor(viewport?: ViewportSize | null): { left: number; top: number; width: number; height: number } {
  if (!viewport) return { ...PARKED_WINDOW_BOUNDS };
  return {
    left: PARKED_WINDOW_BOUNDS.left,
    top: PARKED_WINDOW_BOUNDS.top,
    width: Math.max(PARKED_WINDOW_BOUNDS.width, viewport.width + WINDOW_CHROME.width),
    height: Math.max(PARKED_WINDOW_BOUNDS.height, viewport.height + WINDOW_CHROME.height),
  };
}
/** 用户临时要看真实窗口时放出来的位置。 */
export const REVEALED_WINDOW_BOUNDS = { left: 80, top: 60, width: 1400, height: 900 } as const;

async function setPageWindowBounds(
  context: BrowserContext,
  page: Page,
  bounds: Record<string, number | string>,
): Promise<boolean> {
  try {
    const session = await context.newCDPSession(page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget') as { windowId: number };
      // 最小化 / 全屏状态下不能直接改位置，先回到 normal
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await session.send('Browser.setWindowBounds', { windowId, bounds });
      return true;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch (error) {
    console.warn(`[browser-host] window-bounds=failed error=${error instanceof Error ? error.name : 'unknown'}`);
    return false;
  }
}

/**
 * Chrome 不给最小化的窗口出帧：截图、读页面都会一直等到超时。用户接管时可能顺手把放出来的
 * 真实窗口最小化，助理接着操作前先把它恢复成 normal（位置不动）。返回是否做了恢复；失败只记日志。
 */
export async function restoreIfMinimized(context: BrowserContext, page: Page): Promise<boolean> {
  try {
    const session = await context.newCDPSession(page);
    try {
      const { windowId, bounds } = await session.send('Browser.getWindowForTarget') as { windowId: number; bounds?: { windowState?: string } };
      if (bounds?.windowState !== 'minimized') return false;
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      return true;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch (error) {
    console.warn(`[browser-host] restore-minimized=failed error=${error instanceof Error ? error.name : 'unknown'}`);
    return false;
  }
}

/** 把页面所在的窗口停到屏幕角落（内嵌模式）；给了视口就按它放大窗口。失败只记日志。 */
export function parkWindow(context: BrowserContext, page: Page, viewport?: ViewportSize | null): Promise<boolean> {
  return setPageWindowBounds(context, page, parkedBoundsFor(viewport));
}

/**
 * 让页面视口跟随现场画面框的比例（Playwright 视口模拟，不依赖真实窗口大小）。
 * park=true（内嵌且窗口没放出来）时顺带把停靠窗口放大到能装下视口。返回是否改了视口。
 */
export async function fitPageViewport(context: BrowserContext, page: Page, viewport: ViewportSize, options: { park?: boolean } = {}): Promise<boolean> {
  if (page.isClosed()) return false;
  const current = page.viewportSize();
  const changed = !current || current.width !== viewport.width || Math.abs(current.height - viewport.height) > 2;
  if (changed) {
    try {
      await page.setViewportSize(viewport);
    } catch (error) {
      console.warn(`[browser-host] fit-viewport=failed error=${error instanceof Error ? error.name : 'unknown'}`);
      return false;
    }
  }
  if (options.park) await parkWindow(context, page, viewport);
  return changed;
}

/** 临时把真实窗口放出来并前置（文件框、插件弹窗等现场画面处理不了的情况）。 */
export async function revealWindow(context: BrowserContext, options: Omit<BringToFrontOptions, 'embedded'> = {}): Promise<Page> {
  const page = await activePage(context);
  await setPageWindowBounds(context, page, { ...REVEALED_WINDOW_BOUNDS });
  return bringToFront(context, options);
}

/**
 * 把浏览器窗口送到用户面前：先让 Tab 成为前台，再用 CDP 把窗口从最小化恢复，
 * macOS 上额外激活应用。每一步失败只记日志——前置是体验增强，不是接管的前提。
 */
export async function bringToFront(
  context: BrowserContext,
  options: BringToFrontOptions = {},
): Promise<Page> {
  const page = await activePage(context);
  if (options.embedded) return page;
  await page.bringToFront().catch(error => {
    console.warn(`[browser-host] bring-to-front=page-failed error=${error instanceof Error ? error.name : 'unknown'}`);
  });
  try {
    const session = await context.newCDPSession(page);
    try {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    } finally {
      await session.detach().catch(() => {});
    }
  } catch (error) {
    console.warn(`[browser-host] bring-to-front=cdp-failed error=${error instanceof Error ? error.name : 'unknown'}`);
  }
  if ((options.platform ?? process.platform) === 'darwin') {
    try {
      await (options.activateApp ?? activateMacApp)(options.channel ?? 'chrome');
    } catch (error) {
      console.warn(`[browser-host] bring-to-front=activate-failed error=${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  return page;
}
