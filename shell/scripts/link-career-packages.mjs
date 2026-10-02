#!/usr/bin/env node
// 把求职领域库（pnpm workspace 的 packages/*）以符号链接挂进 shell/node_modules/@career/*。
//
// 为什么用符号链接而不是 npm 依赖：shell 用 npm、领域库用 pnpm，两套 lockfile；
// 领域库的依赖（node:sqlite 之外的 @react-pdf、@napi-rs/canvas、playwright-core …）
// 在 packages/<name>/node_modules 下由 pnpm 管理。Node 解析符号链接时走 realpath，
// 因此领域库内部的 import 从各自的 pnpm node_modules 找，shell 侧不需要重复安装。
//
// 顺带保证 @career/core 的 dist/db/schema.sql 存在（tsc 不拷贝 .sql，openDb().migrate() 需要它）。
// 幂等；postinstall 调用。领域库尚未构建时只给出提示，不让 npm install 失败。
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, '..');
const packagesRoot = resolve(shellRoot, '..', 'packages');
const scopeDir = join(shellRoot, 'node_modules', '@career');
const PACKAGES = ['core', 'resume', 'apply', 'bridges'];

export function linkCareerPackages({ log = console.log, warn = console.warn } = {}) {
  if (!existsSync(packagesRoot)) {
    warn(`[link-career-packages] 找不到 ${packagesRoot}，跳过（shell 可能被单独检出）`);
    return [];
  }
  mkdirSync(scopeDir, { recursive: true });
  const linked = [];
  for (const name of PACKAGES) {
    const target = join(packagesRoot, name);
    const linkPath = join(scopeDir, name);
    if (!existsSync(join(target, 'package.json'))) {
      warn(`[link-career-packages] packages/${name} 不存在，跳过`);
      continue;
    }
    const relTarget = relative(dirname(linkPath), target);
    try {
      const st = lstatSync(linkPath);
      if (st.isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === target) {
        linked.push(name);
        continue;
      }
      rmSync(linkPath, { recursive: true, force: true });
    } catch {
      /* 不存在 */
    }
    symlinkSync(relTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    log(`[link-career-packages] @career/${name} -> ${relTarget}`);
    linked.push(name);
  }
  // core 的 schema.sql
  const schemaSrc = join(packagesRoot, 'core', 'src', 'db', 'schema.sql');
  const schemaDist = join(packagesRoot, 'core', 'dist', 'db', 'schema.sql');
  if (existsSync(schemaSrc) && existsSync(dirname(schemaDist))) {
    if (!existsSync(schemaDist) || readFileSync(schemaSrc, 'utf8') !== readFileSync(schemaDist, 'utf8')) {
      copyFileSync(schemaSrc, schemaDist);
      log('[link-career-packages] 已同步 @career/core dist/db/schema.sql');
    }
  }
  const unbuilt = linked.filter(name => !existsSync(join(packagesRoot, name, 'dist', 'index.js')));
  if (unbuilt.length) {
    warn(`[link-career-packages] 以下领域库尚未构建（运行 \`pnpm -r build\`）：${unbuilt.map(n => `@career/${n}`).join(', ')}`);
  }
  return linked;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  linkCareerPackages();
}
