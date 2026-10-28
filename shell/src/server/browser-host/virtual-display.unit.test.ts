import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PARKED_WINDOW_BOUNDS, parkedWindowBounds } from './page-control';
import { EMBEDDED_WINDOW_CHROMIUM_ARGS, embeddedWindowArgs, resolveBrowserRuntimePolicy } from './runtime-settings';
import {
  isIsolated,
  isolatedOrigins,
  parseDisplays,
  setVirtualParkTarget,
  touchesAlongEdge,
  VirtualDisplay,
  type DisplayRect,
} from './virtual-display';
import type { HelperEvent, HelperProcess } from './window-helper-binary';

// macOS 虚拟屏：真机流程见 scripts/career-vdisplay-smoke.mjs。

/** 2026-10-26 实测布局：外接屏在主屏正上方偏左。 */
const MAIN: DisplayRect = { id: 1, x: 0, y: 0, w: 1512, h: 982, main: true };
const ABOVE: DisplayRect = { id: 2, x: -240, y: -1080, w: 1920, h: 1080 };
const SIZE = { w: 1440, h: 1660 };

/** 假助手：按 place 命令把虚拟屏放过去；adjust 模拟 macOS 改动位置。 */
function fakeHelper(options: { others: DisplayRect[]; start: { x: number; y: number }; adjust?: (x: number, y: number) => { x: number; y: number }; firstEvent?: HelperEvent }) {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null });
  const self = { id: 9, ...options.start, ...SIZE };
  let others = options.others;
  let onEvent: (event: HelperEvent) => void = () => {};
  const sent: string[] = [];
  const report = (ev: string): HelperEvent => ({ ev, self: 9, displays: [...others, { ...self }] });
  const proc: HelperProcess = {
    child: child as unknown as HelperProcess['child'],
    send: line => {
      sent.push(line);
      const m = /^place (-?\d+) (-?\d+)$/.exec(line);
      if (!m) return;
      const at = options.adjust?.(Number(m[1]), Number(m[2])) ?? { x: Number(m[1]), y: Number(m[2]) };
      Object.assign(self, at);
      queueMicrotask(() => onEvent(report('placed')));
    },
    close: vi.fn(),
  };
  const spawn = vi.fn((_bin: string, _args: string[], handler: (event: HelperEvent) => void) => {
    onEvent = handler;
    queueMicrotask(() => onEvent(options.firstEvent ?? report('displays')));
    return proc;
  });
  return {
    spawn, sent, child, self,
    rearrange(next: DisplayRect[]) { others = next; onEvent(report('displays')); },
    exit() { child.exitCode = 0; child.emit('exit', 0); },
  };
}

const display = (helper: ReturnType<typeof fakeHelper>, extra: Partial<ConstructorParameters<typeof VirtualDisplay>[0]> = {}) =>
  new VirtualDisplay({ binDir: '/unused', width: SIZE.w, height: SIZE.h, resolveBinary: async () => '/bin/helper', spawn: helper.spawn, ...extra });

describe('虚拟屏放置', () => {
  it('只碰一个角不算贴边；共用一段边或重叠才算', () => {
    expect(touchesAlongEdge(MAIN, { id: 3, x: -100, y: -100, w: 100, h: 100 })).toBe(false);
    expect(touchesAlongEdge(MAIN, { id: 3, x: -100, y: 0, w: 100, h: 100 })).toBe(true);
    expect(touchesAlongEdge(MAIN, { id: 3, x: 10, y: 10, w: 100, h: 100 })).toBe(true);
    expect(touchesAlongEdge(MAIN, { id: 3, x: -300, y: 0, w: 100, h: 100 })).toBe(false);
  });

  it('回归：外接屏在上方时，macOS 把旧位置推成贴着外接屏左边——判为不安全', () => {
    const measured = { id: 9, x: -1680, y: -1660, ...SIZE };
    expect(isIsolated(measured, [MAIN, ABOVE])).toBe(false);
  });

  it('候选位置主屏优先，只留和所有屏都不共用边的', () => {
    const origins = isolatedOrigins([MAIN, ABOVE], SIZE.w, SIZE.h);
    // 主屏左上对角和外接屏重叠，被排除；第一个候选是主屏左下对角
    expect(origins[0]).toEqual({ x: -SIZE.w, y: MAIN.h });
    expect(origins).not.toContainEqual({ x: -SIZE.w, y: -SIZE.h });
    for (const o of origins) expect(isIsolated({ id: 9, ...o, ...SIZE }, [MAIN, ABOVE])).toBe(true);
  });

  it('拆分助手上报：虚拟屏自己 vs 其余屏', () => {
    const parsed = parseDisplays({ ev: 'displays', self: 9, displays: [MAIN, { id: 9, x: 1, y: 2, w: 3, h: 4 }, { id: 'x' }] });
    expect(parsed.self).toMatchObject({ id: 9, x: 1 });
    expect(parsed.others).toEqual([MAIN]);
  });
});

describe('VirtualDisplay', () => {
  afterEach(() => setVirtualParkTarget(null));

  it('初始位置贴边就挪到安全位置，以系统实际给的结果为准', async () => {
    const helper = fakeHelper({ others: [MAIN, ABOVE], start: { x: -1680, y: -1660 } });
    const bounds = await display(helper).ensure();
    expect(helper.sent).toEqual([`place ${-SIZE.w} ${MAIN.h}`]);
    expect(bounds).toEqual({ displayID: 9, x: -SIZE.w, y: MAIN.h, ...SIZE });
  });

  it('macOS 改了位置导致贴边时换下一个候选', async () => {
    // 第一个候选被系统往右推了 10px（贴住主屏左边），第二个照放
    let calls = 0;
    const helper = fakeHelper({ others: [MAIN, ABOVE], start: { x: -1680, y: -1660 }, adjust: (x, y) => (++calls === 1 ? { x: x + 10, y } : { x, y }) });
    const bounds = await display(helper).ensure();
    expect(helper.sent).toHaveLength(2);
    expect(isIsolated({ id: 9, ...bounds }, [MAIN, ABOVE])).toBe(true);
  });

  it('每个候选都被推到贴边：创建失败（宿主改用隐藏兜底）并关掉助手', async () => {
    const helper = fakeHelper({ others: [MAIN], start: { x: 0, y: 982 }, adjust: x => ({ x, y: 982 - 1 }) });
    await expect(display(helper).ensure()).rejects.toThrow('找不到');
    expect(helper.spawn.mock.results[0].value.close).toHaveBeenCalled();
  });

  it('助手报错：创建失败', async () => {
    const helper = fakeHelper({ others: [MAIN], start: { x: -1440, y: -1660 }, firstEvent: { ev: 'error', error: 'create failed' } });
    await expect(display(helper).ensure()).rejects.toThrow('create failed');
  });

  it('屏幕重排：仍安全不动；变得贴边就挪并通知 onMoved', async () => {
    const onMoved = vi.fn();
    const helper = fakeHelper({ others: [MAIN], start: { x: -SIZE.w, y: -SIZE.h } });
    const vd = display(helper, { onMoved });
    await vd.ensure();
    expect(helper.sent).toEqual([]);
    // 插上一块屏，正好挡在虚拟屏右边
    helper.rearrange([MAIN, { id: 3, x: 0, y: -SIZE.h, w: 1920, h: SIZE.h }]);
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledOnce());
    expect(isIsolated({ id: 9, ...vd.current()! }, [MAIN, { id: 3, x: 0, y: -SIZE.h, w: 1920, h: SIZE.h }])).toBe(true);
  });

  it('屏幕重排后挪不开：通知 onUnsafe', async () => {
    const onUnsafe = vi.fn();
    let locked = false;
    const helper = fakeHelper({ others: [MAIN], start: { x: -SIZE.w, y: -SIZE.h }, adjust: (x, y) => (locked ? { x: -SIZE.w + 1, y: -SIZE.h + 1 } : { x, y }) });
    await display(helper, { onUnsafe }).ensure();
    locked = true;
    helper.rearrange([MAIN, { id: 3, x: -SIZE.w, y: -SIZE.h - 100, w: SIZE.w, h: 100 }]);
    await vi.waitFor(() => expect(onUnsafe).toHaveBeenCalledOnce());
  });

  it('助手意外退出才算 onLost；主动 stop 不算', async () => {
    const onLost = vi.fn();
    const helper = fakeHelper({ others: [MAIN], start: { x: -SIZE.w, y: -SIZE.h } });
    const vd = display(helper, { onLost });
    await vd.ensure();
    helper.exit();
    expect(onLost).toHaveBeenCalledOnce();
    expect(vd.current()).toBeNull();

    const helper2 = fakeHelper({ others: [MAIN], start: { x: -SIZE.w, y: -SIZE.h } });
    const vd2 = display(helper2, { onLost });
    await vd2.ensure();
    vd2.stop();
    helper2.exit();
    expect(onLost).toHaveBeenCalledOnce();
  });
});

describe('虚拟屏开关与停靠目标', () => {
  afterEach(() => setVirtualParkTarget(null));

  it('开关：macOS 缺省开（corner 关闭），其余平台永远没有', () => {
    expect(resolveBrowserRuntimePolicy({}, '/h', 'darwin').virtualDisplay).toBe(true);
    expect(resolveBrowserRuntimePolicy({ CAREER_BROWSER_WINDOW: 'virtual-display' }, '/h', 'darwin').virtualDisplay).toBe(true);
    expect(resolveBrowserRuntimePolicy({ CAREER_BROWSER_WINDOW: 'corner' }, '/h', 'darwin').virtualDisplay).toBe(false);
    expect(resolveBrowserRuntimePolicy({ CAREER_BROWSER_WINDOW: 'window' }, '/h', 'darwin').virtualDisplay).toBe(false);
    expect(resolveBrowserRuntimePolicy({ CAREER_BROWSER_WINDOW: 'virtual-display' }, '/h', 'win32').virtualDisplay).toBe(false);
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
});
