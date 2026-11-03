/**
 * macOS 原生小助手（Objective-C 单文件，一行一个 JSON 事件）的定位与开发机现场编译。
 *
 * 发布包里由构建脚本预编译（双架构、已签名），放在 server-dist.js 旁的 `<resourceDir>/`；开发时用
 * `src-tauri/resources/<resourceDir>/` 里的同一份产物。都没有时才在开发机上现场编译，而且只在确认装了命令行工具时才编：
 * `/usr/bin/clang` 是每台 Mac 都有的占位程序，没装工具时一调用就弹"安装命令行开发者工具"对话框。
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { getScriptDir } from './runtime';

export interface NativeHelperSpec {
  /** 可执行文件名，如 career-window-helper。 */
  name: string;
  /** 安装包 / src-tauri/resources 下的目录名。 */
  resourceDir: string;
  /** 源码位置（开发机现场编译用）；打包后的 server-dist.js 旁通常不存在。 */
  source: URL;
  frameworks: string[];
}

/** 向上找 src-tauri/resources 的层数：开发时 server 源码目录到仓库 shell 根目录不超过这么多层。 */
const DEV_RESOURCE_SEARCH_DEPTH = 6;
/** 检查命令行工具是否安装的超时。 */
const XCODE_SELECT_TIMEOUT_MS = 5_000;
/** 开发机现场编译的超时。 */
const COMPILE_TIMEOUT_MS = 120_000;

const run = (cmd: string, args: string[], timeout: number) => new Promise<string>((resolvePromise, reject) => {
  execFile(cmd, args, { timeout }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
});

function sourcePath(spec: NativeHelperSpec): string | null {
  try {
    const path = fileURLToPath(spec.source);
    return existsSync(path) ? path : null;
  } catch (error) {
    console.warn(`[native-helper] ${spec.name} 源码路径无效:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** 预编译产物：发布包在 server-dist.js 旁；开发时向上找 src-tauri/resources。 */
export function findPrebuiltHelper(spec: Pick<NativeHelperSpec, 'name' | 'resourceDir'>, scriptDir: string = getScriptDir()): string | null {
  const bundled = resolve(scriptDir, spec.resourceDir, spec.name);
  if (existsSync(bundled)) return bundled;
  let dir = scriptDir;
  for (let i = 0; i < DEV_RESOURCE_SEARCH_DEPTH; i++) {
    const staged = resolve(dir, 'src-tauri', 'resources', spec.resourceDir, spec.name);
    if (existsSync(staged)) return staged;
    dir = dirname(dir);
  }
  return null;
}

async function compileOnDevMachine(spec: NativeHelperSpec, devBinDir: string): Promise<string> {
  const source = sourcePath(spec);
  if (!source) throw new Error(`安装包里没有 ${spec.name}`);
  // 先确认命令行工具在：没装时 xcode-select -p 失败，且不会弹任何对话框
  await run('/usr/bin/xcode-select', ['-p'], XCODE_SELECT_TIMEOUT_MS)
    .catch(() => { throw new Error(`没有命令行开发者工具，也没有预编译的 ${spec.name}`); });
  const tag = createHash('sha1').update(readFileSync(source)).digest('hex').slice(0, 10);
  mkdirSync(devBinDir, { recursive: true });
  const bin = join(devBinDir, `${spec.name}-${tag}`);
  if (existsSync(bin)) return bin;
  const frameworks = spec.frameworks.flatMap(f => ['-framework', f]);
  await run('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-O2', '-mmacosx-version-min=13.0', ...frameworks, '-o', bin, source], COMPILE_TIMEOUT_MS);
  return bin;
}

export interface HelperEvent { ev: string; [key: string]: unknown }
export interface HelperProcess {
  child: ChildProcess;
  send(line: string): void;
  /** stdin 关闭，助手自行退出；超时没退就强杀。 */
  close(): void;
}

/** close() 后等助手自己退出的时间，过了就强杀。 */
const HELPER_EXIT_GRACE_MS = 1500;

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
      try { onEvent(JSON.parse(line) as HelperEvent); } catch { console.warn(`[native-helper] ${bin} 输出了非 JSON 行，已忽略`); }
    }
  });
  // 助手已退出时写 stdin 会报 EPIPE；退出本身由调用方经 child 'exit' 处理
  child.stdin!.on('error', error => console.warn(`[native-helper] ${bin} stdin:`, error.message));
  return {
    child,
    send: line => { if (child.exitCode === null && child.stdin?.writable) child.stdin.write(`${line}\n`); },
    close: () => {
      child.stdin?.end();
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, HELPER_EXIT_GRACE_MS).unref?.();
    },
  };
}

const resolving = new Map<string, Promise<string>>();

/** 找到（必要时在开发机上编译）助手；找不到就抛错，调用方退回无助手的行为。同一个助手并发只解析一次。 */
export function resolveNativeHelper(spec: NativeHelperSpec, devBinDir: string): Promise<string> {
  let pending = resolving.get(spec.name);
  if (!pending) {
    pending = (async () => findPrebuiltHelper(spec) ?? compileOnDevMachine(spec, devBinDir))()
      .catch((error: unknown) => { resolving.delete(spec.name); throw error; });
    resolving.set(spec.name, pending);
  }
  return pending;
}
