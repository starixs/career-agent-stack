import { readdirSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from 'vitest';

import { INTERNAL_SKILLS, SKILL_POINTS, WORKBENCHES } from './catalog';

// 功能市场要和内置技能一一对应：每个技能要么在一张工作台卡里、要么是一个技能点、要么明确登记为不摆出来。
// 新加一个技能却没在功能市场给它位置，用户就不会知道我们有这个本事。
const SKILLS_DIR = resolve(__dirname, '../../../../../../skills');
const skillFolders = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

describe('功能市场清单', () => {
  const placed = [...WORKBENCHES, ...SKILL_POINTS].flatMap(entry => entry.skills);

  it('每个内置技能都有且只有一个位置', () => {
    expect([...placed, ...INTERNAL_SKILLS].sort()).toEqual(skillFolders);
  });

  it('清单里的 id 不重复', () => {
    const ids = [...WORKBENCHES, ...SKILL_POINTS].map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个技能点都说得出特别在哪、说哪句话会用上', () => {
    for (const point of SKILL_POINTS) {
      expect(point.special.length, point.id).toBeGreaterThanOrEqual(3);
      expect(point.ask.trim(), point.id).not.toBe('');
    }
  });

  it('要选岗位的技能点，把选中的岗位写进发出去的那句话', () => {
    for (const point of SKILL_POINTS.filter(p => p.start?.inputs.includes('job'))) {
      expect(point.start?.say({ jobId: 'j1', jobLabel: '甲公司 · 后端开发' }), point.id).toContain('甲公司 · 后端开发');
    }
  });
});
