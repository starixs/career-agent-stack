// 预编译 macOS 原生小助手（Objective-C 单文件）的公共流程：双架构（arm64 + x86_64）一份，放到
// src-tauri/resources/<dir>/，由 tauri.macos.conf.json 打进安装包；发布构建在打包前签名。
// 用户机器上不再现场编译——没装命令行工具的 Mac 一调用 clang 就弹"安装开发者工具"对话框。
// 源码没变就跳过（按源码哈希）。非 macOS 主机直接跳过。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STAMP_FILE = '.source-sha256';

export function objcHelperCompileArgs(source, output, frameworks) {
  return ['clang', '-fobjc-arc', '-O2', '-Wall', '-Werror', '-mmacosx-version-min=13.0', '-arch', 'arm64', '-arch', 'x86_64',
    ...frameworks.flatMap(f => ['-framework', f]), '-o', output, source];
}

/**
 * @param {{ name: string, source: string, outDir: string, frameworks: string[] }} spec
 * @returns {string | null} 产物路径；非 macOS 返回 null
 */
export function prepareObjcHelper(spec, { platform = process.platform, run = execFileSync, log = console.log } = {}) {
  const { name, source, outDir, frameworks } = spec;
  if (platform !== 'darwin') { log(`${name}: 非 macOS，跳过`); return null; }
  const bin = join(outDir, name);
  const stamp = join(outDir, STAMP_FILE);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) {
    log(`${name}: 已是最新`);
    return bin;
  }
  mkdirSync(outDir, { recursive: true });
  // 在临时目录里用最终文件名编译：链接器的临时签名标识取自文件名
  const tmpDir = mkdtempSync(join(outDir, '.build-'));
  const tmp = join(tmpDir, name);
  run('xcrun', objcHelperCompileArgs(source, tmp, frameworks), { stdio: 'inherit' });
  const archs = String(run('lipo', ['-archs', tmp], { encoding: 'utf8' })).trim().split(/\s+/).sort().join(' ');
  if (archs !== 'arm64 x86_64') throw new Error(`${name}: 架构不对（${archs}）`);
  renameSync(tmp, bin);
  rmSync(tmpDir, { recursive: true, force: true });
  writeFileSync(stamp, `${hash}\n`);
  log(`${name}: 已编译 ${bin}`);
  return bin;
}
