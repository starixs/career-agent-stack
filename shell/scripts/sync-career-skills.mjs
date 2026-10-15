// 把 app/skills/<name>/ 同步到 bundled-workspaces/career/.claude/skills/<name>/，
// 让 Agent SDK 在固定工作区里也能直接看到这些技能（产品内工具集另从 app/skills 读取提示词）。
//
// 删掉的技能也要从目标目录里清掉，否则旧副本会一直被打包进工作区模板。目标目录里没有标记能区分
// 「同步来的」和「手工放进去的」，所以只清理登记在 RETIRED_SKILLS 里、且源目录已经没有的名字；
// 以后在 app/skills 删掉一个技能时，把名字加到这里。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 已从 app/skills 删除的技能：目标目录里残留的同名副本会被删掉。 */
export const RETIRED_SKILLS = Object.freeze(['memory-consolidate', 'memory-extract']);

/** @returns {{ synced: string[]; pruned: string[] } | null} 源目录不存在时返回 null。 */
export function syncCareerSkills(src, dest, retired = RETIRED_SKILLS) {
  if (!existsSync(src)) return null;
  mkdirSync(dest, { recursive: true });
  const synced = [];
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (!statSync(from).isDirectory() || !existsSync(join(from, 'SKILL.md'))) continue;
    const to = join(dest, name);
    if (existsSync(to)) rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    synced.push(name);
  }
  const pruned = [];
  for (const name of retired) {
    if (synced.includes(name)) continue;
    const stale = join(dest, name);
    if (!existsSync(stale)) continue;
    rmSync(stale, { recursive: true, force: true });
    pruned.push(name);
  }
  return { synced, pruned };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = resolve(here, '..', '..', 'skills');
  const dest = resolve(here, '..', 'bundled-workspaces', 'career', '.claude', 'skills');
  const result = syncCareerSkills(src, dest);
  if (!result) {
    console.warn(`[sync-career-skills] 跳过：未找到 ${src}`);
  } else {
    const pruned = result.pruned.length ? `；清理已删除的技能 ${result.pruned.join('、')}` : '';
    console.log(`[sync-career-skills] 已同步 ${result.synced.length} 个技能到 ${dest}${pruned}`);
  }
}
