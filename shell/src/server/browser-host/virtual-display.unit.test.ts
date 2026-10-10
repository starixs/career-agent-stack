import { afterEach, describe, expect, it } from 'vitest';

import { PARKED_WINDOW_BOUNDS, parkedWindowBounds } from './page-control';
import { EMBEDDED_WINDOW_CHROMIUM_ARGS, embeddedWindowArgs, resolveBrowserRuntimePolicy } from './runtime-settings';
import { parseVirtualDisplayLine, setVirtualParkTarget, VIRTUAL_DISPLAY_SOURCE } from './virtual-display';

// macOS 虚拟屏（可选）：真机流程见 scripts/career-vdisplay-smoke.mjs。

describe('虚拟屏', () => {
  afterEach(() => setVirtualParkTarget(null));

  it('开关：只在 macOS + CAREER_BROWSER_WINDOW=virtual-display 时开', () => {
    expect(resolveBrowserRuntimePolicy({ CAREER_BROWSER_WINDOW: 'virtual-display' }, '/h', 'darwin').virtualDisplay).toBe(true);
    expect(resolveBrowserRuntimePolicy({ CAREER_BROWSER_WINDOW: 'virtual-display' }, '/h', 'win32').virtualDisplay).toBe(false);
    expect(resolveBrowserRuntimePolicy({}, '/h', 'darwin').virtualDisplay).toBe(false);
  });

  it('解析助手输出；报错 / 尺寸无效时抛出（宿主退回角落）', () => {
    expect(parseVirtualDisplayLine('{"displayID":8,"x":-1366,"y":-768,"w":1366,"h":768}')).toEqual({ displayID: 8, x: -1366, y: -768, w: 1366, h: 768 });
    expect(() => parseVirtualDisplayLine('{"error":"create failed"}')).toThrow('create failed');
    expect(() => parseVirtualDisplayLine('{"displayID":8,"x":0,"y":0,"w":0,"h":0}')).toThrow();
  });

  it('有虚拟屏：启动位置与停靠位置都在虚拟屏上；没有就退回角落', () => {
    expect(parkedWindowBounds('darwin')).toEqual(PARKED_WINDOW_BOUNDS);
    expect(embeddedWindowArgs('darwin')).toBe(EMBEDDED_WINDOW_CHROMIUM_ARGS);
    setVirtualParkTarget({ displayID: 8, x: -1366, y: -768, w: 1366, h: 768 });
    expect(parkedWindowBounds('darwin')).toEqual({ left: -1366, top: -768, width: 1366, height: 768 });
    const args = embeddedWindowArgs('darwin');
    expect(args).toContain('--window-position=-1366,-768');
    expect(args).toContain('--window-size=1366,768');
    expect(args.filter(a => a.startsWith('--window-position='))).toHaveLength(1);
    // Windows 不受影响
    expect(parkedWindowBounds('win32').top).toBe(-10000);
  });

  it('助手源码：放到主屏左上对角（只碰一个角），stdin 关闭即退出', () => {
    expect(VIRTUAL_DISPLAY_SOURCE).toContain('CGConfigureDisplayOrigin(cfg, display.displayID, (int)main.origin.x - (int)w, (int)main.origin.y - (int)h)');
    expect(VIRTUAL_DISPLAY_SOURCE).toContain('if (read(STDIN_FILENO, buf, sizeof buf) <= 0) exit(0);');
    expect(VIRTUAL_DISPLAY_SOURCE).toContain('printf("{\\"displayID\\":%u');
  });
});
