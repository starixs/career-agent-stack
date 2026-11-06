/**
 * 简历汇总页的示例：一份做好的主简历缩略图。姓名用编造的「陈思远」，不放电话、邮箱、照片；学校、公司都是虚构的。
 * 用简历工作台同一套模板渲染（resume-studio 的默认文档 + 中文内容）。
 */
import { defaultResumeData, type ResumeData } from '@career/resume-studio/schema';

const link = { url: '', label: '', inlineLink: false };

export const SAMPLE_RESUME: ResumeData = {
  ...defaultResumeData,
  picture: { ...defaultResumeData.picture, hidden: true },
  basics: { ...defaultResumeData.basics, name: '陈思远', headline: '后端开发 · 2027 届硕士', location: '杭州' },
  summary: { ...defaultResumeData.summary, content: '<p>两段后端实习，做过运营平台的配置与权限模块、积分兑换的高并发优化；课程项目里用 Function Calling 搭过 Agent 工具。</p>' },
  sections: {
    ...defaultResumeData.sections,
    education: { ...defaultResumeData.sections.education, items: [
      { id: 'sample_edu_1', hidden: false, school: '江南理工大学', degree: '硕士', area: '计算机技术', grade: '', location: '无锡', period: '2024 - 2027', website: link, description: '' },
      { id: 'sample_edu_2', hidden: false, school: '江南理工大学', degree: '本科', area: '软件工程', grade: '', location: '无锡', period: '2020 - 2024', website: link, description: '' },
    ] },
    experience: { ...defaultResumeData.sections.experience, items: [
      {
        id: 'sample_exp_1', hidden: false, company: '比邻数据', position: '后端开发实习生', location: '杭州', period: '2025.06 - 2025.09', website: link, roles: [],
        description: '<ul><li><p>负责运营管理平台的任务配置、用户权限模块的后端接口开发</p></li><li><p>积分兑换模块的高并发优化：Redis 缓存活动规则与用户状态，数据库直连请求削减 80%</p></li><li><p>总结接口联调检查清单，在组内推广使用</p></li></ul>',
      },
    ] },
    projects: { ...defaultResumeData.sections.projects, items: [
      {
        id: 'sample_prj_1', hidden: false, name: '运营配置平台', period: '2025', website: link,
        description: '<p>基于 Apollo 的三层动态配置体系，规则配置层独立设计与上线，营销活动规则无代码调整。</p>',
      },
    ] },
    skills: { ...defaultResumeData.sections.skills, items: [
      { id: 'sample_skl_1', hidden: false, icon: '', iconColor: '', name: '后端', proficiency: '', level: 0, keywords: ['Java', 'Spring Boot', 'MySQL', 'Redis'] },
      { id: 'sample_skl_2', hidden: false, icon: '', iconColor: '', name: 'AI 应用', proficiency: '', level: 0, keywords: ['Function Calling', 'RAG'] },
    ] },
  },
  metadata: { ...defaultResumeData.metadata, page: { ...defaultResumeData.metadata.page, locale: 'zh-CN' } },
};
