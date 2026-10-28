// 预编译 macOS 原生窗口助手（src/server/browser-host/native/career-window-helper.m）：
// 虚拟屏 + 托管 Chrome 焦点守卫 / 隐藏兜底。双架构（arm64 + x86_64）一份，放到
// src-tauri/resources/window-helper/，tauri.macos.conf.json 把它打进安装包；发布构建在打包前签名。
// 用户机器上不再现场编译——没装命令行工具的 Mac 一调用 clang 就弹"安装开发者工具"对话框。
// 源码没变就跳过（按源码哈希）。非 macOS 主机直接跳过。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WINDOW_HELPER_SOURCE = join(ROOT, 'src', 'server', 'browser-host', 'native', 'career-window-helper.m');
export const WINDOW_HELPER_OUT_DIR = join(ROOT, 'src-tauri', 'resources', 'window-helper');
export const WINDOW_HELPER_BIN = join(WINDOW_HELPER_OUT_DIR, 'career-window-helper');
const STAMP = join(WINDOW_HELPER_OUT_DIR, '.source-sha256');

export function windowHelperCompileArgs(source, output) {
  return ['clang', '-fobjc-arc', '-O2', '-Wall', '-Werror', '-mmacosx-version-min=13.0', '-arch', 'arm64', '-arch', 'x86_64',
    '-framework', 'AppKit', '-framework', 'CoreGraphics', '-o', output, source];
}

export function prepareWindowHelper({ platform = process.platform, run = execFileSync, log = console.log } = {}) {
  if (platform !== 'darwin') { log('window-helper: 非 macOS，跳过'); return null; }
  const hash = createHash('sha256').update(readFileSync(WINDOW_HELPER_SOURCE)).digest('hex');
  if (existsSync(WINDOW_HELPER_BIN) && existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === hash) {
    log('window-helper: 已是最新');
    return WINDOW_HELPER_BIN;
  }
  mkdirSync(WINDOW_HELPER_OUT_DIR, { recursive: true });
  // 在临时目录里用最终文件名编译：链接器的临时签名标识取自文件名
  const tmpDir = mkdtempSync(join(WINDOW_HELPER_OUT_DIR, '.build-'));
  const tmp = join(tmpDir, 'career-window-helper');
  run('xcrun', windowHelperCompileArgs(WINDOW_HELPER_SOURCE, tmp), { stdio: 'inherit' });
  const archs = String(run('lipo', ['-archs', tmp], { encoding: 'utf8' })).trim().split(/\s+/).sort().join(' ');
  if (archs !== 'arm64 x86_64') throw new Error(`window-helper: 架构不对（${archs}）`);
  renameSync(tmp, WINDOW_HELPER_BIN);
  rmSync(tmpDir, { recursive: true, force: true });
  writeFileSync(STAMP, `${hash}\n`);
  log(`window-helper: 已编译 ${WINDOW_HELPER_BIN}`);
  return WINDOW_HELPER_BIN;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWindowHelper();
}
