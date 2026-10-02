/**
 * 求职技能包目录解析：`CAREER_SKILLS_DIR` 优先，否则按候选路径查找 app/skills。
 *
 * 候选路径覆盖三种运行形态：
 *   - 开发态（tsx 直接跑 src/server/...）：shell/src/server/career → ../../../../skills
 *   - 打包态（src-tauri/resources/server-dist.js）：resources/skills 或 resources/../skills
 *   - 以 shell 为 cwd 启动：cwd/../skills
 * 这里只做纯路径计算与存在性检查，不读取技能内容。
 */
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

let cached: string | null | undefined;

function scriptDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

export function careerSkillsDirCandidates(): string[] {
  const here = scriptDir();
  const env = process.env.CAREER_SKILLS_DIR?.trim();
  return [
    ...(env ? [resolve(env)] : []),
    resolve(here, '../../../../skills'),
    resolve(here, '../../../skills'),
    resolve(here, '../../skills'),
    resolve(here, '../skills'),
    resolve(here, 'skills'),
    resolve(process.cwd(), '../skills'),
    resolve(process.cwd(), 'skills'),
  ];
}

/** 返回技能根目录；找不到返回 null（调用方决定用内置简版提示词还是报错）。 */
export function resolveCareerSkillsDir(): string | null {
  if (cached !== undefined && !process.env.CAREER_SKILLS_DIR) return cached;
  const found = careerSkillsDirCandidates().find(dir => existsSync(resolve(dir, 'assistant-core', 'SKILL.md')) || existsSync(resolve(dir, 'jd-parse', 'SKILL.md')));
  cached = found ?? null;
  return cached;
}

/** 测试用：清掉缓存。 */
export function resetCareerSkillsDirCache(): void {
  cached = undefined;
}
