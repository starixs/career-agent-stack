// 把 app/skills/<name>/ 同步到 bundled-workspaces/career/.claude/skills/<name>/，
// 让 Agent SDK 在固定工作区里也能直接看到这些技能（产品内工具集另从 app/skills 读取提示词）。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '..', '..', 'skills');
const dest = resolve(here, '..', 'bundled-workspaces', 'career', '.claude', 'skills');

if (!existsSync(src)) {
  console.warn(`[sync-career-skills] 跳过：未找到 ${src}`);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
let n = 0;
for (const name of readdirSync(src)) {
  const from = join(src, name);
  if (!statSync(from).isDirectory() || !existsSync(join(from, 'SKILL.md'))) continue;
  const to = join(dest, name);
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  n++;
}
console.log(`[sync-career-skills] 已同步 ${n} 个技能到 ${dest}`);
