import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { WindowGuard } from './window-guard';
import type { HelperEvent, HelperProcess } from './window-helper-binary';

// 原生助手的真机行为见 scripts/career-vdisplay-smoke.mjs（焦点 / 隐藏两节）。

function fakeHelpers(options: { ready?: boolean } = {}) {
  const procs: Array<{ sent: string[]; exit: () => void; close: ReturnType<typeof vi.fn> }> = [];
  const spawn = vi.fn((_bin: string, args: string[], onEvent: (event: HelperEvent) => void) => {
    expect(args).toEqual(['guard']);
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null });
    const sent: string[] = [];
    const close = vi.fn();
    procs.push({ sent, close, exit: () => { child.exitCode = 1; child.emit('exit', 1); } });
    if (options.ready !== false) queueMicrotask(() => onEvent({ ev: 'ready' }));
    return { child, send: (line: string) => sent.push(line), close } as unknown as HelperProcess;
  });
  return { spawn, procs };
}

const guardWith = (helpers: ReturnType<typeof fakeHelpers>) =>
  new WindowGuard({ binDir: '/unused', resolveBinary: async () => '/bin/helper', spawn: helpers.spawn });

describe('WindowGuard', () => {
  it('启动 Chrome 前认领 profile；隐藏 / 放出 / 遗忘都转成助手命令（路径可含空格）', async () => {
    const helpers = fakeHelpers();
    const guard = guardWith(helpers);
    await guard.expect('/p/a b', { hidden: true });
    expect(guard.running()).toBe(true);
    guard.setPaused('/p/a b', true);
    guard.setHidden('/p/a b', false);
    guard.forget('/p/a b');
    guard.setHidden('/p/a b', true); // 已遗忘：不再发
    expect(helpers.procs[0].sent).toEqual(['expect 1 /p/a b', 'pause 1 /p/a b', 'hidden 0 /p/a b', 'forget /p/a b']);
    expect(guard.state('/p/a b')).toBeNull();
  });

  it('多个会话共用一个助手', async () => {
    const helpers = fakeHelpers();
    const guard = guardWith(helpers);
    await Promise.all([guard.expect('/p/1'), guard.expect('/p/2', { hidden: true })]);
    expect(helpers.spawn).toHaveBeenCalledOnce();
    expect(helpers.procs[0].sent).toEqual(expect.arrayContaining(['expect 0 /p/1', 'expect 1 /p/2']));
  });

  it('助手意外退出：重启并重放隐藏 / 放出状态', async () => {
    vi.useFakeTimers();
    try {
      const helpers = fakeHelpers();
      const guard = guardWith(helpers);
      await guard.expect('/p/1', { hidden: true });
      guard.setPaused('/p/1', true);
      helpers.procs[0].exit();
      expect(guard.running()).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      expect(helpers.spawn).toHaveBeenCalledTimes(2);
      expect(helpers.procs[1].sent).toEqual(['expect 1 /p/1', 'pause 1 /p/1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('主动 stop 后不重启', async () => {
    vi.useFakeTimers();
    try {
      const helpers = fakeHelpers();
      const guard = guardWith(helpers);
      await guard.expect('/p/1');
      guard.stop();
      expect(helpers.procs[0].close).toHaveBeenCalled();
      helpers.procs[0].exit();
      await vi.advanceTimersByTimeAsync(5000);
      expect(helpers.spawn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('助手不回应：expect 报错（调用方只记日志），之后可以再试', async () => {
    vi.useFakeTimers();
    try {
      const helpers = fakeHelpers({ ready: false });
      const guard = guardWith(helpers);
      const pending = guard.expect('/p/1');
      const assertion = expect(pending).rejects.toThrow('没有回应');
      await vi.advanceTimersByTimeAsync(5100);
      await assertion;
      expect(guard.running()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
