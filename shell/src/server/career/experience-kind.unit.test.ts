import { describe, expect, it } from 'vitest';

import { backfillExperienceKinds, INTAKE_KV_PREFIX, KIND_OF_SECTION } from './resume-intake';
import { createMemoryRepos } from './test-db';

describe('经历类别（填网申时实习 / 项目 / 校园分开）', () => {
  it('简历分区对应类别：实习工作 → work，项目 → project，校园 → campus', () => {
    expect(KIND_OF_SECTION).toEqual({ experience: 'work', project: 'project', campus: 'campus' });
  });

  it('老数据按导入草稿补类别：只改还是 other 的，可重复执行；草稿坏了不影响', () => {
    const repos = createMemoryRepos();
    const intern = repos.createExperience({ title: '上海某电商 · 后端开发实习生', org: '上海某电商科技公司', role: '后端开发实习生', type: 'other' });
    const acm = repos.createExperience({ title: '校 ACM 集训队成员', org: '校 ACM 集训队', role: '成员', type: 'other' });
    const edited = repos.createExperience({ title: '学生会', org: '计算机学院学生会技术部', type: 'work' });
    repos.kvSet(`${INTAKE_KV_PREFIX}rin_1`, { entries: [{ experience_id: intern.id, section: 'experience' }, { experience_id: acm.id, section: 'campus' }, { experience_id: edited.id, section: 'campus' }, { experience_id: 'x', section: 'bogus' }] });
    repos.kvSet(`${INTAKE_KV_PREFIX}rin_bad`, '不是对象');
    expect(backfillExperienceKinds(repos)).toBe(2);
    const typeOf = (id: string) => repos.listExperiences().find(e => e.id === id)?.type;
    expect([typeOf(intern.id), typeOf(acm.id), typeOf(edited.id)]).toEqual(['work', 'campus', 'work']);
    expect(backfillExperienceKinds(repos)).toBe(0);
  });
});
