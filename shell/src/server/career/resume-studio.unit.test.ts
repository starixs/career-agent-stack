import { describe, expect, it } from 'vitest';
import { StaticKeyProvider, Vault } from '@career/core';

import { createMemoryRepos } from './test-db';
import { CareerStore } from './store';
import { loadCore } from './core-module';
import { htmlToLines, splitPeriod } from './resume-studio-convert';
import { loadStudio, previewPlaceholders, saveStudio } from './resume-studio';

// 简历工作台：内容（schema_json）⇄ 排版文档（resume-studio ResumeData）。
// 来回一圈不丢工作台表达不了的字段；工具改过内容后按新内容重建、保留排版；占位符不被解成明文写回。

const content = {
  version: 1,
  basics: { name: '{{vault:profile.name}}', phone: '{{vault:profile.phone}}', email: 'me@x.com', city: '上海', objective: '后端开发', expected_salary: '15-20K', target_cities: ['上海', '杭州'], links: [{ label: 'GitHub', url: 'https://github.com/me' }] },
  education: [{ id: 'edu_a', school: '复旦大学', degree: '本科', major: '计算机科学', start: '2021.09', end: '2025.06', gpa: '3.8/4.0', courses: ['数据结构', '操作系统'], bullets: ['ACM 校队'], claim_ids: ['clm_1'] }],
  experience: [{ id: 'exp_a', org: '字节跳动', position: '后端实习生', department: '推荐架构', location: '北京', start: '2024.06', end: '2024.09', bullets: ['重构召回服务，P99 降低 40%', '接入 Kafka 消息总线'], roles: [], claim_ids: ['clm_2'] }],
  projects: [{ id: 'prj_a', name: '分布式 KV', role: '负责人', org: '课程设计', start: '2023.03', end: '2023.06', link: 'https://github.com/me/kv', bullets: ['Raft 共识'], claim_ids: [] }],
  skills: [{ id: 'skl_a', name: '后端', level: '熟练', keywords: ['Go', 'Java'], claim_ids: [] }],
  awards: [{ id: 'awd_a', title: 'ICPC 银牌', issuer: 'ICPC', date: '2023.11', description: '亚洲区域赛', claim_ids: [] }],
  certifications: [], custom_sections: [], section_order: ['education', 'experience', 'projects', 'skills', 'awards', 'certifications', 'custom_sections'], section_titles: { experience: '实习经历' },
};

async function setup() {
  const repos = createMemoryRepos();
  const core = await loadCore();
  const store = new CareerStore(repos, core);
  const master = store.createResumeMaster({ name: '主简历', schema_json: JSON.stringify(content) });
  const vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7)));
  vault.set({ scope: 'profile', field: 'name', value: '张三' });
  vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
  return { repos, store, vault, id: master.id };
}

describe('简历工作台', () => {
  it('首次打开：按内容生成中文排版文档（A4 / zh-CN），条目、时间段、富文本要点都对上', async () => {
    const { repos, store, id } = await setup();
    const { data, rebuilt } = await loadStudio({ repos, store }, id);
    expect(rebuilt).toBe(true);
    expect(data.metadata.page).toMatchObject({ locale: 'zh-CN', format: 'a4' });
    expect(data.basics).toMatchObject({ name: '{{vault:profile.name}}', headline: '后端开发', location: '上海', website: { url: 'https://github.com/me' } });
    expect(data.basics.customFields.map(f => f.text)).toEqual(['期望薪资：15-20K', '期望城市：上海 / 杭州']);
    const exp = data.sections.experience;
    expect(exp.title).toBe('实习经历');
    expect(exp.items[0]).toMatchObject({ id: 'exp_a', company: '字节跳动', position: '后端实习生', period: '2024.06 - 2024.09' });
    expect(htmlToLines(exp.items[0].description)).toEqual(['重构召回服务，P99 降低 40%', '接入 Kafka 消息总线']);
    expect(htmlToLines(data.sections.education.items[0].description)).toEqual(['主修课程：数据结构、操作系统', 'ACM 校队']);
    // 第二次打开：内容没变 → 用存下的文档
    expect((await loadStudio({ repos, store }, id)).rebuilt).toBe(false);
  });

  it('工作台保存：内容回写，工作台表达不了的字段（部门、claim_ids、项目角色）按 id 保留；排版也存下', async () => {
    const { repos, store, id } = await setup();
    const { data } = await loadStudio({ repos, store }, id);
    data.sections.experience.items[0].description = '<ul><li><p>重构召回服务，P99 降低 45%</p></li></ul><p>新增一条</p>';
    data.sections.projects.items[0].period = '2023.03 – 2023.07';
    data.metadata.template = 'azurill';
    const saved = await saveStudio({ repos, store }, id, data);
    expect(saved.snapshot).toBe(true);
    const row = JSON.parse(store.getResume(id)!.row.schema_json);
    expect(row.experience[0]).toMatchObject({ department: '推荐架构', claim_ids: ['clm_2'], bullets: ['重构召回服务，P99 降低 45%', '新增一条'] });
    expect(row.projects[0]).toMatchObject({ role: '负责人', org: '课程设计', start: '2023.03', end: '2023.07', bullets: ['Raft 共识'] });
    expect(row.education[0].courses).toEqual(['数据结构', '操作系统']);
    expect(row.basics).toMatchObject({ name: '{{vault:profile.name}}', target_cities: ['上海', '杭州'], expected_salary: '15-20K' });
    const again = await loadStudio({ repos, store }, id);
    expect(again.rebuilt).toBe(false);
    expect(again.data.metadata.template).toBe('azurill');
    // 10 分钟内再保存不再打快照
    expect((await saveStudio({ repos, store }, id, again.data)).snapshot).toBe(false);
  });

  it('工具改了内容：按新内容重建，排版（模板）保留', async () => {
    const { repos, store, id } = await setup();
    const { data } = await loadStudio({ repos, store }, id);
    data.metadata.template = 'pikachu';
    await saveStudio({ repos, store }, id, data);
    const next = JSON.parse(store.getResume(id)!.row.schema_json);
    next.experience[0].bullets.push('工具新增的要点');
    await new Promise(r => setTimeout(r, 5));
    store.saveResume(id, next, '助理修改前快照');
    const reopened = await loadStudio({ repos, store }, id);
    expect(reopened.rebuilt).toBe(true);
    expect(reopened.data.metadata.template).toBe('pikachu');
    expect(htmlToLines(reopened.data.sections.experience.items[0].description)).toContain('工具新增的要点');
  });

  it('预览明文只单独返回，不进文档', async () => {
    const { repos, store, vault, id } = await setup();
    const { data } = await loadStudio({ repos, store, vault }, id);
    expect(previewPlaceholders({ vault }, data, id)).toEqual({ '{{vault:profile.name}}': '张三', '{{vault:profile.phone}}': '13800138000' });
    expect(JSON.stringify(data)).not.toContain('13800138000');
  });

  it('时间段拆分', () => {
    expect(splitPeriod('2021.09 - 2025.06')).toEqual({ start: '2021.09', end: '2025.06' });
    expect(splitPeriod('2024.06 至今')).toEqual({ start: '2024.06', end: '至今' });
    expect(splitPeriod('2024.06 - 至今')).toEqual({ start: '2024.06', end: '至今' });
    expect(splitPeriod('2023.01 至 2023.05')).toEqual({ start: '2023.01', end: '2023.05' });
    expect(splitPeriod('2024.06')).toEqual({ start: '2024.06', end: '' });
  });
});
