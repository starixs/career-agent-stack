import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { KeepAwake } from './keep-awake';

function fakeSpawn() {
  const calls: string[][] = [];
  const kids: Array<EventEmitter & { killed: boolean }> = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const kid = Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; return true; } });
    kids.push(kid);
    return kid as unknown as ChildProcess;
  };
  return { calls, kids, spawn };
}

describe('KeepAwake（2026-11-05 屏幕睡了托管浏览器每次点击要 50 秒以上）', () => {
  it('投递在跑时开一个 caffeinate 跟着侧车进程，重复调用不重复开；停了就收', () => {
    const f = fakeSpawn();
    const k = new KeepAwake({ platform: 'darwin', spawn: f.spawn, pid: 42 });
    k.follow(true); k.follow(true);
    expect(f.calls).toEqual([['/usr/bin/caffeinate', '-d', '-i', '-w', '42']]);
    k.follow(false);
    expect(f.kids[0]?.killed).toBe(true);
    expect(k.active).toBe(false);
  });

  it('不是 macOS 不开', () => {
    const f = fakeSpawn();
    new KeepAwake({ platform: 'win32', spawn: f.spawn, pid: 1 }).follow(true);
    expect(f.calls).toEqual([]);
  });
});
