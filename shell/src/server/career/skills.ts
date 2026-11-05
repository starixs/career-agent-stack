/**
 * 技能提示词加载：`loadSkill/skillPrompt` 来自 @career/core，根目录由 skills-dir.ts 解析。
 * 失败时抛中文错误（技能目录缺失 / 技能不存在），由工具层转成 isError 文本。
 */
import type { LLM, Skill } from '@career/core';
import { loadCore, type CoreModule } from './core-module';
import { resolveCareerSkillsDir } from './skills-dir';

const cache = new Map<string, Skill>();

export async function loadCareerSkill(name: string): Promise<Skill> {
  const core = await loadCore();
  const dir = resolveCareerSkillsDir();
  if (!dir) throw new Error('找不到求职技能目录（app/skills）；可用 CAREER_SKILLS_DIR 指定');
  const key = `${dir}::${name}`;
  let skill = cache.get(key);
  if (!skill) {
    try {
      skill = core.loadSkill(dir, name);
    } catch (error) {
      throw new Error(`技能 ${name} 加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
    cache.set(key, skill);
  }
  return skill;
}

/** 技能正文 + 指定 references 拼成 system prompt。 */
export async function loadSkillPrompt(name: string, refs: string[] = []): Promise<string> {
  const core = await loadCore();
  return core.skillPrompt(await loadCareerSkill(name), refs);
}

export function resetSkillCache(): void {
  cache.clear();
}

/** 后台（批量定制、邮件起草）调技能：技能提示词 + 共享模型 → JSON。不推进展事件、不出卡。 */
export function backgroundAskSkill(llm: LLM, core: Pick<CoreModule, 'extractJson'>) {
  return async <T>(skill: string, user: string, o: { refs?: string[]; temperature?: number } = {}): Promise<T> => {
    const res = await llm.complete({ system: await loadSkillPrompt(skill, o.refs ?? []), messages: [{ role: 'user', content: user }], json: true, temperature: o.temperature ?? 0.3 });
    return core.extractJson<T>(res.text);
  };
}
