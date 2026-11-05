import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CAREER_TOOL_INTERNAL_SKILLS, chatVisibleSkills } from './chat-skill-scope';
import { resolveCareerSkillsDir } from './skills-dir';

describe('chat skill scope', () => {
  it('every tool-internal skill still exists in app/skills (tools read the file directly)', () => {
    const dir = resolveCareerSkillsDir();
    expect(dir).not.toBeNull();
    for (const name of CAREER_TOOL_INTERNAL_SKILLS) {
      expect(existsSync(join(dir!, name, 'SKILL.md')), name).toBe(true);
    }
  });

  it('hides tool-internal skills and keeps conversational ones in order', () => {
    expect(chatVisibleSkills([
      'apply-playbook', 'assistant-core', 'experience-interview', 'jd-parse', 'keystone-anydoc', 'resume-tailor',
    ])).toEqual(['apply-playbook', 'experience-interview', 'keystone-anydoc']);
  });
});
