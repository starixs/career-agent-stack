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

const run = (cmd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { timeout: MAC_ACTIVATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** 从进程表里挑出托管 Chrome 的主进程：带这个 profile 目录、且不是 --type= 的子进程。纯函数便于测试。 */
export function findBrowserMainPid(psOutput: string, profileDir: string): number | null {
  const marker = `--user-data-dir=${profileDir}`;
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[2];
    if (!command.includes(marker) || command.includes(' --type=')) continue;
    if (!new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(command)) continue;
    return Number(m[1]);
  }
  return null;
}

/**
 * 激活托管 Chrome：按进程号，而不是按应用 ID。按 `com.google.Chrome` 激活会把用户自己正在用的 Chrome 拉到前台，
 * 输入也可能落进用户的窗口——托管浏览器和用户的浏览器是同一个应用、不同进程，只能按进程区分。
 * 找不到进程就不激活（宁可不前置，也不碰错进程）。
 */
async function activateManagedBrowser(_channel: BrowserChannel, profileDir?: string): Promise<void> {
  if (!profileDir) throw new Error('profile directory unknown; refusing to activate by bundle id');
  const pid = findBrowserMainPid(await run('ps', ['-axo', 'pid=,command=']), profileDir);
  if (!pid) throw new Error('managed browser process not found');
  await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
}

export interface BringToFrontOptions {
  channel?: BrowserChannel;
  platform?: NodeJS.Platform;
  /** 托管 Chrome 的 profile 目录：按它找到进程号再激活。 */
  profileDir?: string | null;
  /** 可替换的 OS 级激活（测试注入）。 */
  activateApp?: (channel: BrowserChannel, profileDir?: string) => Promise<void>;
  /**
   * 内嵌窗口模式：用户在产品内的现场画面里操作，不能把真实 Chrome 拉到前面打断心流。
   * 只返回当前页，不切前台、不恢复窗口、不激活应用。
   */
  embedded?: boolean;
}

/** 内嵌模式下窗口停靠的位置：极远的左下角，macOS 会夹回屏幕内只露出一小角。 */
export const PARKED_WINDOW_BOUNDS = { left: -10000, top: 10000, width: 500, height: 375 } as const;
/** Windows 不夹回：停到屏幕外就完全看不见（再配合工具窗口样式去掉任务栏按钮）。 */
export const PARKED_WINDOW_BOUNDS_WIN32 = { left: -10000, top: -10000, width: 500, height: 375 } as const;
export const parkedWindowBounds = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? PARKED_WINDOW_BOUNDS_WIN32 : PARKED_WINDOW_BOUNDS);
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
 * 把页面所在的窗口停到屏幕角落（内嵌模式）。Windows 上再把托管 Chrome 从任务栏 / Alt+Tab 去掉（按 profile 找进程）。
 * 失败只记日志。
 */
export async function parkWindow(context: BrowserContext, page: Page, opts: { profileDir?: string | null; platform?: NodeJS.Platform; hideFromTaskbar?: (profileDir: string) => Promise<number> } = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const ok = await setPageWindowBounds(context, page, { ...parkedWindowBounds(platform) });
  if (platform === 'win32' && opts.profileDir) {
    const hide = opts.hideFromTaskbar ?? (async (dir: string) => (await import('./windows-window')).hideManagedChromeFromTaskbar(dir));
    void hide(opts.profileDir).catch(error => console.warn(`[browser-host] taskbar-hide=failed error=${error instanceof Error ? error.message : 'unknown'}`));
  }
  return ok;
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
      await (options.activateApp ?? activateManagedBrowser)(options.channel ?? 'chrome', options.profileDir ?? undefined);
    } catch (error) {
      console.warn(`[browser-host] bring-to-front=activate-failed error=${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  return page;
}
