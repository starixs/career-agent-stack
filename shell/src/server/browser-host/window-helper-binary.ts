/**
 * macOS 原生窗口助手（native/career-window-helper.m）的可执行文件位置。
 *
 * 发布包里由 scripts/prepare-window-helper.mjs 预编译（双架构、已签名），放在 server-dist.js 旁的
 * `window-helper/`；开发时用 `src-tauri/resources/window-helper/` 里的同一份产物。都没有时才在开发机上现场编译，
 * 而且只在确认装了命令行工具时才编：`/usr/bin/clang` 是每台 Mac 都有的占位程序，没装工具时一调用就弹
 * "安装命令行开发者工具"对话框——托管浏览器的初衷就是不打扰用户，不能因为它多弹一个窗口。
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getScriptDir } from '../utils/runtime';

export const WINDOW_HELPER_NAME = 'career-window-helper';
const RESOURCE_DIR = 'window-helper';

const run = (cmd: string, args: string[], timeout: number) => new Promise<string>((resolvePromise, reject) => {
  execFile(cmd, args, { timeout }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
});

function sourcePath(): string | null {
  try {
    const path = fileURLToPath(new URL('./native/career-window-helper.m', import.meta.url));
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** 预编译产物：发布包在 server-dist.js 旁；开发时向上找 src-tauri/resources。 */
export function findPrebuiltWindowHelper(scriptDir: string = getScriptDir()): string | null {
  const bundled = resolve(scriptDir, RESOURCE_DIR, WINDOW_HELPER_NAME);
  if (existsSync(bundled)) return bundled;
  let dir = scriptDir;
  for (let i = 0; i < 6; i++) {
    const staged = resolve(dir, 'src-tauri', 'resources', RESOURCE_DIR, WINDOW_HELPER_NAME);
    if (existsSync(staged)) return staged;
    dir = dirname(dir);
  }
  return null;
}

export interface HelperEvent { ev: string; [key: string]: unknown }
export interface HelperProcess {
  child: ChildProcess;
  send(line: string): void;
  /** stdin 关闭，助手自行退出；1.5 秒没退就强杀。 */
  close(): void;
}

/** 启动助手：stdout 一行一个 JSON 事件，stdin 一行一条命令。 */
export function spawnHelper(bin: string, args: string[], onEvent: (event: HelperEvent) => void): HelperProcess {
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line) as HelperEvent); } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.stdin!.on('error', () => { /* 助手已退出 */ });
  return {
    child,
    send: line => { if (child.exitCode === null && child.stdin?.writable) child.stdin.write(`${line}\n`); },
    close: () => {
      child.stdin?.end();
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1500).unref?.();
    },
  };
}

let resolving: Promise<string> | null = null;

/** 找到（必要时在开发机上编译）窗口助手；找不到就抛错，调用方退回无助手的行为。 */
export function resolveWindowHelper(devBinDir: string): Promise<string> {
  resolving ??= (async () => {
    const prebuilt = findPrebuiltWindowHelper();
    if (prebuilt) return prebuilt;
    const source = sourcePath();
    if (!source) throw new Error('安装包里没有窗口助手');
    // 先确认命令行工具在：没装时 xcode-select -p 失败，且不会弹任何对话框
    await run('/usr/bin/xcode-select', ['-p'], 5_000).catch(() => { throw new Error('没有命令行开发者工具，也没有预编译的窗口助手'); });
    const tag = createHash('sha1').update(readFileSync(source)).digest('hex').slice(0, 10);
    mkdirSync(devBinDir, { recursive: true });
    const bin = join(devBinDir, `${WINDOW_HELPER_NAME}-${tag}`);
    if (existsSync(bin)) return bin;
    await run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-O2', '-mmacosx-version-min=13.0', '-framework', 'AppKit', '-framework', 'CoreGraphics', '-o', bin, source], 120_000);
    return bin;
  })().catch(error => { resolving = null; throw error; });
  return resolving;
}
