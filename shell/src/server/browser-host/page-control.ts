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
