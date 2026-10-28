import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, BrowserType, Page } from 'playwright';

import { BrowserContextRegistry } from './context-registry';
import type { BrowserRuntimePolicy } from './runtime-settings';
import { setVirtualParkTarget, type VirtualDisplayOptions } from './virtual-display';
import { WindowGuard } from './window-guard';
import type { HelperEvent, HelperProcess } from './window-helper-binary';

// 托管窗口的三种状态：虚拟屏（只守焦点）/ 隐藏兜底（守焦点 + 藏起来 + 无合成截图）/ 用户放出真实窗口（都不管）。

const binding = { productSessionId: 'a', workspacePath: '/workspace/a', hostGeneration: 1 };

function fakePage() {
  return Object.assign(new EventEmitter(), {
    isClosed: () => false,
    screenshot: vi.fn(async () => Buffer.from('surface')),
    viewportSize: () => ({ width: 1366, height: 768 }),
    setViewportSize: vi.fn(async () => {}),
  }) as unknown as Page & { screenshot: ReturnType<typeof vi.fn> };
}

function harness(options: { display: 'ok' | 'fail'; guardReady?: boolean }) {
  const profileRoot = mkdtempSync(join(tmpdir(), 'reg-window-'));
  const page = fakePage();
  const cdp = vi.fn(async (method: string) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1366, clientHeight: 768 } };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('surfaceless').toString('base64') };
    if (method === 'Browser.getWindowForTarget') return { windowId: 1 };
    return {};
  });
  const events = new EventEmitter();
  const context = Object.assign(events, {
    close: vi.fn(async () => { events.emit('close'); }),
    pages: vi.fn(() => [page]),
    newPage: vi.fn(),
    addCookies: vi.fn(async () => {}),
    addInitScript: vi.fn(async () => {}),
    cookies: vi.fn(async () => []),
    newCDPSession: vi.fn(async () => ({ send: cdp, detach: vi.fn(async () => {}) })),
  }) as unknown as BrowserContext;

  const sent: string[] = [];
  const spawn = vi.fn((_bin: string, _args: string[], onEvent: (event: HelperEvent) => void) => {
    if (options.guardReady !== false) queueMicrotask(() => onEvent({ ev: 'ready' }));
    return { child: Object.assign(new EventEmitter(), { exitCode: null }), send: (line: string) => sent.push(line), close: vi.fn() } as unknown as HelperProcess;
  });
  let displayOptions: VirtualDisplayOptions | null = null;
  const display = {
    ensure: vi.fn(async () => {
      if (options.display === 'fail') throw new Error('create failed');
      return { displayID: 9, x: -1440, y: 982, w: 1440, h: 1660 };
    }),
    stop: vi.fn(),
  };
  const launchPersistentContext = vi.fn(async (dir: string) => {
    // 守卫必须在 Chrome 启动之前就认领这个 profile
    if (options.guardReady !== false) expect(sent.some(line => line.startsWith('expect ') && line.endsWith(dir))).toBe(true);
    return context;
  });
  const policy: BrowserRuntimePolicy = {
    persistentProfile: true, systemChrome: true, mirrorIdentity: false, profileRoot,
    embeddedWindow: true, virtualDisplay: true, windowGuard: true,
  };
  const registry = new BrowserContextRegistry({
    readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
    checkpointIdentity: vi.fn(async (_s, _b, _o, state) => ({ revision: 2, state, conflictCount: 0 })),
    resolveResource: vi.fn(async () => ({ revision: 'r', executablePath: '/x' })),
    loadBrowserType: vi.fn(async () => ({ launchPersistentContext } as unknown as BrowserType)),
    runtimePolicy: policy,
    createWindowGuard: () => new WindowGuard({ binDir: profileRoot, resolveBinary: async () => '/bin/helper', spawn }),
    createVirtualDisplay: opts => { displayOptions = opts; return display; },
  });
  return {
    registry, page, cdp, sent, display, profileRoot,
    displayOptions: () => displayOptions!,
    dir: () => registry.profileDirFor('a')!,
    cleanup: async () => { await registry.shutdown().catch(() => {}); rmSync(profileRoot, { recursive: true, force: true }); },
  };
}

let active: ReturnType<typeof harness> | null = null;
afterEach(async () => { await active?.cleanup(); active = null; setVirtualParkTarget(null); });

describe('托管窗口：虚拟屏 / 隐藏兜底', () => {
  it('虚拟屏可用：只守焦点不隐藏，截图照常走 Playwright', async () => {
    const h = active = harness({ display: 'ok' });
    const context = await h.registry.getContext(binding);
    expect(h.sent).toContain(`expect 0 ${h.dir()}`);
    expect(h.registry.surfacelessCapture('a')).toBe(false);
    await context.pages()[0].screenshot();
    expect(h.page.screenshot).toHaveBeenCalledOnce();
  });

  it('虚拟屏建不出来：隐藏兜底——启动前就要求藏起来，借出去的页面截图改走 fromSurface:false', async () => {
    const h = active = harness({ display: 'fail' });
    const context = await h.registry.getContext(binding);
    expect(h.sent).toContain(`expect 1 ${h.dir()}`);
    expect(h.registry.surfacelessCapture('a')).toBe(true);
    const shot = await context.pages()[0].screenshot({ type: 'jpeg', quality: 40 });
    expect(shot.toString()).toBe('surfaceless');
    expect(h.page.screenshot).not.toHaveBeenCalled();
    expect(h.cdp).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({ fromSurface: false, format: 'jpeg', quality: 40 }));
    // 之后不再反复尝试建虚拟屏
    await h.registry.getContext(binding);
    expect(h.display.ensure).toHaveBeenCalledOnce();
  });

  it('虚拟屏中途消失：已在运行的 Chrome 立即藏起来', async () => {
    const h = active = harness({ display: 'ok' });
    await h.registry.getContext(binding);
    expect(h.registry.surfacelessCapture('a')).toBe(false);
    h.displayOptions().onLost?.();
    expect(h.sent).toContain(`hidden 1 ${h.dir()}`);
    expect(h.registry.surfacelessCapture('a')).toBe(true);
  });

  it('用户放出真实窗口：暂停守卫与隐藏，截图恢复正常；收回后恢复', async () => {
    const h = active = harness({ display: 'fail' });
    await h.registry.getContext(binding);
    await h.registry.setWindowRevealed('a', true);
    expect(h.sent).toContain(`pause 1 ${h.dir()}`);
    expect(h.registry.surfacelessCapture('a')).toBe(false);
    await h.registry.setWindowRevealed('a', false);
    expect(h.sent).toContain(`pause 0 ${h.dir()}`);
    expect(h.registry.surfacelessCapture('a')).toBe(true);
  });

  it('守卫起不来：不挡启动，也不会假装藏起来（截图仍走 Playwright）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = active = harness({ display: 'fail', guardReady: false });
      const pending = h.registry.getContext(binding);
      await vi.advanceTimersByTimeAsync(5100);
      await pending;
      expect(h.registry.surfacelessCapture('a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Chrome 关掉：守卫遗忘这个 profile', async () => {
    const h = active = harness({ display: 'ok' });
    const dirPromise = h.registry.getContext(binding).then(() => h.dir());
    const dir = await dirPromise;
    await h.registry.shutdown();
    expect(h.sent).toContain(`forget ${dir}`);
  });
});
