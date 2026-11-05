/**
 * 批量投递进行时不让屏幕睡：屏幕一睡整机不出帧，托管浏览器的 CDP 点击、截图都要等下一帧，
 * 一次点击从 1 秒变成 50–77 秒（2026-11-05 夜跑实测，见 [bridge-cdp] slow 埋点）。
 * macOS 用系统自带的 caffeinate；它跟着侧车进程（-w），侧车没了它也自己退。只在投递进行时开，停了就收。
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface KeepAwakeDeps { platform: NodeJS.Platform; spawn: (cmd: string, args: string[]) => ChildProcess; pid: number }

export class KeepAwake {
  private child: ChildProcess | null = null;
  constructor(private readonly deps: KeepAwakeDeps = { platform: process.platform, spawn: (cmd, args) => spawn(cmd, args, { stdio: 'ignore' }), pid: process.pid }) {}

  /** 投递在跑就开，不在跑就关；重复调用不重复开。 */
  follow(running: boolean): void {
    if (running) this.start(); else this.stop();
  }

  get active(): boolean { return this.child !== null; }

  private start(): void {
    if (this.child || this.deps.platform !== 'darwin') return;
    try {
      const child = this.deps.spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(this.deps.pid)]);
      child.on('error', e => { console.warn('[career] keep-awake: caffeinate 起不来', e.message); if (this.child === child) this.child = null; });
      child.on('exit', () => { if (this.child === child) this.child = null; });
      this.child = child;
      console.log('[career] keep-awake: 批量投递进行中，保持屏幕常亮');
    } catch (e) {
      console.warn('[career] keep-awake: caffeinate 起不来', e instanceof Error ? e.message : e);
    }
  }

  private stop(): void {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    console.log('[career] keep-awake: 批量投递停了，屏幕照常睡');
  }
}

/** 设置里的开关（缺省开）：career kv 里存 false 才算关。 */
export const KEEP_AWAKE_KEY = 'career:keep_awake';
interface FlagStore { kvGet<T = unknown>(key: string): T | undefined }
export const keepAwakeEnabled = (repos: FlagStore) => repos.kvGet<boolean>(KEEP_AWAKE_KEY) !== false;

/** 整个侧车一份。 */
export const keepAwake = new KeepAwake();
/** 批量状态变了 / 开关变了都走这里：在投且开着才常亮。 */
export function followBatch(repos: FlagStore, status: unknown): void {
  keepAwake.follow(status === 'running' && keepAwakeEnabled(repos));
}
