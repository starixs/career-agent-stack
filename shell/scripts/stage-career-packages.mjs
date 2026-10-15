#!/usr/bin/env node
// 发布包携带求职领域库：server-dist.js 把 @career/* 列为 external（它们的依赖里有 node:sqlite、
// react-pdf、@napi-rs/canvas 原生模块等，不能打进单文件 bundle），运行时从 Resources/node_modules/@career/*
// 解析。这里把每个包用 `pnpm deploy --prod` 生成一份"自带 node_modules 的独立副本"，
// 放到 src-tauri/resources/career-modules/@career/<name>，tauri.conf 把它映射到 node_modules/@career。
//
//  - 先 `pnpm -r build`（dist 是 .gitignore 的，必须现编）；
//  - node-linker=hoisted：副本里是真实目录，没有指向 pnpm store 的符号链接（打包器不一定保留链接）；
//  - 删掉 node_modules/.bin（只有指向脚本的链接，运行时用不到）；
//  - 领域库运行时要读的仓库 modules/ 数据（目前只有 campus-radar/jobs.json）拷到 career-modules/modules/<name>，
//    tauri.conf 映射到 Resources/modules/<name>：@career/bridges 在 Resources/node_modules/@career/bridges/dist 里
//    按 stackRoot（上溯四级 = Resources）找 modules/，与开发时的仓库布局一致（见 bridges/src/campusRadar.ts）。
// 用法：node scripts/stage-career-packages.mjs   （build:assets 会调用）
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(shellRoot, '..');
const stageRoot = join(shellRoot, 'src-tauri', 'resources', 'career-modules', '@career');
const modulesStageRoot = join(shellRoot, 'src-tauri', 'resources', 'career-modules', 'modules');
const stackRoot = resolve(appRoot, '..');
/** 随包发布的 modules 数据文件（相对仓库根 modules/）。 */
const MODULE_FILES = ['campus-radar/jobs.json'];
const PACKAGES = ['core', 'resume', 'resume-studio', 'apply', 'bridges'];

const run = (cmd, args, cwd = appRoot) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

if (!existsSync(join(appRoot, 'pnpm-workspace.yaml'))) {
  console.error(`[stage-career-packages] 找不到 ${appRoot}/pnpm-workspace.yaml，跳过`);
  process.exit(1);
}

// 逐个包直接跑它自己的 build（pnpm -r run 会先做依赖校验，非交互环境下可能要求重装 node_modules）
for (const name of PACKAGES) {
  console.log(`[stage-career-packages] 构建 @career/${name}…`);
  run('npm', ['run', 'build'], join(appRoot, 'packages', name));
}

rmSync(stageRoot, { recursive: true, force: true });
for (const name of PACKAGES) {
  const out = join(stageRoot, name);
  console.log(`[stage-career-packages] 部署 @career/${name} → ${out}`);
  run('pnpm', ['--filter', `@career/${name}`, 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', out]);
  const bin = join(out, 'node_modules', '.bin');
  if (existsSync(bin)) rmSync(bin, { recursive: true, force: true });
  if (!existsSync(join(out, 'dist'))) throw new Error(`@career/${name} 没有 dist：package.json 需要 "files": ["dist"]`);
}

// 瘦身：运行时用不到的 source map / 类型声明；phosphor 图标包只会按 ESM 加载（*.es.js），删掉重复的 CommonJS 副本（约 60MB）
const prune = (dir, depth = 0) => {
  if (depth > 12 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isDirectory()) { prune(p, depth + 1); continue; }
    const phosphorCjs = p.includes('phosphor-icons-react-pdf') && entry.endsWith('.cjs.js');
    if (entry.endsWith('.map') || /\.d\.[cm]?ts$/.test(entry) || phosphorCjs) rmSync(p, { force: true });
  }
};
prune(stageRoot);

// 兜底检查：副本里不应再有符号链接（打包器可能不保留，运行时会找不到模块）
const links = [];
const walk = (dir, depth = 0) => {
  if (depth > 6) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) links.push(p);
    else if (st.isDirectory()) walk(p, depth + 1);
  }
};
walk(stageRoot);
if (links.length) {
  console.warn(`[stage-career-packages] 仍有 ${links.length} 个符号链接，示例：${links.slice(0, 3).join(', ')}`);
}
// 领域库运行时读取的 modules 数据
rmSync(modulesStageRoot, { recursive: true, force: true });
for (const rel of MODULE_FILES) {
  const src = join(stackRoot, 'modules', rel);
  if (!existsSync(src)) throw new Error(`缺少 modules/${rel}（校招数据随包发布，找不到会让岗位汇总表空着）`);
  const out = join(modulesStageRoot, rel);
  mkdirSync(dirname(out), { recursive: true });
  copyFileSync(src, out);
  console.log(`[stage-career-packages] 拷贝 modules/${rel} → ${out}`);
}

// @career/core 需要 dist/db/schema.sql（tsc 不拷贝 .sql，build 脚本会补；这里再确认一次）
if (!existsSync(join(stageRoot, 'core', 'dist', 'db', 'schema.sql'))) throw new Error('@career/core 缺少 dist/db/schema.sql');
console.log('[stage-career-packages] 完成');
