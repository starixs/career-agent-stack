import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';

import { parkWindow, parkedWindowBounds, PARKED_WINDOW_BOUNDS_WIN32 } from './page-control';
import { embeddedWindowArgs, EMBEDDED_WINDOW_CHROMIUM_ARGS } from './runtime-settings';
import { findManagedChromePidScript, hideFromTaskbarScript, psQuote } from './windows-window';

// Windows 托管窗口：屏幕外停靠 + 关原生遮挡计算 + 工具窗口样式去任务栏。这台机器跑不了 PowerShell，测生成的脚本与分支。

describe('Windows 托管窗口', () => {
  it('启动参数：Windows 关掉原生遮挡计算、停到屏幕外；macOS 不变', () => {
    expect(embeddedWindowArgs('win32')).toEqual(expect.arrayContaining(['--disable-features=CalculateNativeWinOcclusion', '--window-position=-10000,-10000']));
    expect(embeddedWindowArgs('darwin')).toBe(EMBEDDED_WINDOW_CHROMIUM_ARGS);
    expect(parkedWindowBounds('win32')).toEqual(PARKED_WINDOW_BOUNDS_WIN32);
    expect(parkedWindowBounds('darwin').top).toBeGreaterThan(0);
  });

  it('找进程的脚本按 profile 匹配、排除子进程，路径里的单引号被转义', () => {
    const script = findManagedChromePidScript("C:\\Users\\o'neil\\.keystone\\browser-profile\\s1");
    expect(script).toContain("$dir = 'C:\\Users\\o''neil\\.keystone\\browser-profile\\s1'");
    expect(script).toContain("-not $_.CommandLine.Contains('--type=')");
    expect(psQuote("a'b")).toBe("'a''b'");
  });

  it('去任务栏脚本：只改目标进程的可见窗口，加 TOOLWINDOW、去 APPWINDOW；进程号必须合法', () => {
    const script = hideFromTaskbarScript(4321);
    expect(script).toContain('$target = 4321');
    expect(script).toContain('$WS_EX_TOOLWINDOW = 0x80');
    expect(script).toContain('-band (-bnot $WS_EX_APPWINDOW)');
    expect(() => hideFromTaskbarScript(0)).toThrow();
    expect(() => hideFromTaskbarScript(1.5)).toThrow();
  });

  it('parkWindow：Windows 上停到屏幕外后去任务栏；macOS 不调用', async () => {
    const send = vi.fn(async (method: string) => (method === 'Browser.getWindowForTarget' ? { windowId: 1 } : {}));
    const context = { newCDPSession: vi.fn(async () => ({ send, detach: async () => {} })) } as unknown as BrowserContext;
    const page = {} as Page;
    const hide = vi.fn(async () => 1);
    await parkWindow(context, page, { platform: 'win32', profileDir: 'C:\\p\\s1', hideFromTaskbar: hide });
    expect(send).toHaveBeenCalledWith('Browser.setWindowBounds', { windowId: 1, bounds: { ...PARKED_WINDOW_BOUNDS_WIN32 } });
    expect(hide).toHaveBeenCalledWith('C:\\p\\s1');
    hide.mockClear();
    await parkWindow(context, page, { platform: 'darwin', profileDir: '/p/s1', hideFromTaskbar: hide });
    expect(hide).not.toHaveBeenCalled();
  });
});
