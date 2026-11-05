import { describe, expect, it } from 'vitest';

import { companyResearchInput } from './company-research-input';

// 公司调研要能说清「这个岗位来了做什么」：带了岗位就把名称和 JD 交给技能；没带就明说没有，技能把这一项留空，不凭岗位名猜。
describe('companyResearchInput', () => {
  it('带了岗位：名称和 JD 都进输入，JD 只取前面一段', () => {
    const jd = `负责订单系统后端开发。${'要求'.repeat(4000)}`;
    const text = companyResearchInput({ companyName: '甲公司', hints: '杭州', job: { title: '后端开发', jd_raw: jd }, hits: [] });
    expect(text).toContain('公司名：甲公司');
    expect(text).toContain('消歧信息：杭州');
    expect(text).toContain('目标岗位：后端开发');
    expect(text).toContain('负责订单系统后端开发。');
    expect(text.length).toBeLessThan(jd.length);
  });

  it('没带岗位，或者岗位没有 JD：明说没有，让技能把岗位说明留空', () => {
    expect(companyResearchInput({ companyName: '甲公司', hits: [] })).toContain('目标岗位：未提供（role 留空）');
    const noJd = companyResearchInput({ companyName: '甲公司', job: { title: '后端开发', jd_raw: '  ' }, hits: [] });
    expect(noJd).toContain('目标岗位：后端开发');
    expect(noJd).toContain('JD：未提供（role 留空）');
  });

  it('搜索结果带条数；没有消歧信息写「无」', () => {
    const text = companyResearchInput({ companyName: '甲公司', hits: [{ title: '官网', url: 'https://example.com' }] });
    expect(text).toContain('消歧信息：无');
    expect(text).toContain('Web Search 结果（1 条）');
    expect(text).toContain('https://example.com');
  });
});
