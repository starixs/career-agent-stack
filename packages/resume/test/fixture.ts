import type { Claim, JdParsed } from '@career/core'
import { parseResume, type Resume } from '../src/index.js'

export function sampleResume(): Resume {
  return parseResume({
    basics: { name: '张三', phone: '13800000000', email: 'zhangsan@example.com', city: '上海', target_cities: ['上海', '杭州'], expected_salary: '8-10K', political_status: '中共党员', objective: '数据分析实习生', availability: '7 月初到岗，每周 4 天，可实习 6 个月' },
    education: [{ school: '复旦大学', degree: '本科', major: '统计学', start: '2022.09', end: '2026.06', gpa: 'GPA 3.7/4.0（前 10%）', courses: ['概率论', '回归分析', '数据库原理'], claim_ids: [] }],
    experience: [{
      org: '某电商科技有限公司', position: '数据分析实习生', department: '用户增长部', location: '上海', start: '2024.07', end: '2024.10',
      bullets: ['维护用户行为数据库，支撑 12 期周度复盘汇报', '用 Python 搭建留存分析看板，覆盖 300 万日活用户', '参与 3 次 A/B 实验设计与结论输出'],
      claim_ids: ['clm_a', 'clm_b'],
    }],
    projects: [{ name: '校园外卖订单分析', role: '组长', start: '2024.03', end: '2024.06', bullets: ['清洗 8 万条订单数据，建立 SQL 分析流程', '输出 20 页分析报告，获课程最高分'], claim_ids: ['clm_c'] }],
    skills: [{ name: '数据分析', keywords: ['Python', 'SQL', 'Excel'], level: '熟练' }, { name: '语言', keywords: ['英语六级'] }],
    awards: [{ title: '校级一等奖学金', issuer: '复旦大学', date: '2023.10' }],
    certifications: [{ title: '已通过 CET-6', date: '2023.12' }],
    custom_sections: [{ title: '校园与志愿', items: [{ title: '统计学会学术部部长', date: '2023.09 - 2024.06', bullets: ['组织 5 场数据分析工作坊，累计 200 人参加'] }] }],
  })
}

export function sampleClaims(): Claim[] {
  const t = '2025-01-01T00:00:00.000Z'
  const mk = (id: string, text: string, status: Claim['status'], result_metric: string | null = null): Claim => ({ id, experience_id: 'exp_1', text, attribution: 'self', result_metric, status, created_from: 'interview', created_at: t, updated_at: t })
  return [
    mk('clm_a', '维护用户行为数据库，支撑周度复盘汇报', 'user_confirmed', '12 期'),
    mk('clm_b', '用 Python 搭建留存分析看板', 'verified', '覆盖 300 万日活'),
    mk('clm_c', '清洗 8 万条订单数据并建立 SQL 分析流程', 'user_confirmed'),
    mk('clm_d', '用 Tableau 做过 2 个可视化仪表盘', 'user_confirmed'),
    mk('clm_pending', '独立负责 5000 万预算的投放策略', 'pending', '5000 万'),
  ]
}

export function sampleJd(): JdParsed {
  return {
    company: '示例科技', title: '数据分析实习生', location: ['上海'],
    hard_requirements: ['本科及以上', '熟练使用 SQL 与 Python', '每周实习 4 天以上'],
    responsibilities: ['搭建业务数据看板', '设计 A/B 实验并输出结论', '沉淀用户行为分析方法'],
    nice_to_have: ['熟悉 Tableau'],
    keywords: { covered: ['SQL', 'Python', 'A/B 实验', '看板'], diggable: ['Tableau'], missing: ['Spark'] },
  }
}
