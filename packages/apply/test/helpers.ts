import { Db, Repos, FakeLLM } from '@career/core'
import type { Profile } from '../src/index.js'

export function mem(): Repos { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

export const profile: Profile = {
  basics: { name: '张三', email: 'zhangsan@example.com', phone: '13800000000', school: '某某大学', major: '计算机科学', degree: '本科', graduation: '2026-06', city: '上海', gender: '男' },
  experiences: [
    { title: '推荐系统重构', org: 'A 公司', role: '算法实习生', period: '2025.03~2025.08', claims: ['把离线特征计算从 6h 压到 40min'] },
    { title: '校园二手平台', org: '课程项目', role: '后端', claims: ['独立实现订单与支付模块'] },
  ],
  answerBank: [
    { question_key: '期望薪资', question_text: '你的期望薪资是多少', answer: '15k-18k', high_impact: true, confirmed: true },
  ],
  resumePath: '/tmp/resume-zhangsan.pdf',
}

export const noLLM = () => new FakeLLM([])
export const draftLLM = (map: Record<string, string>) => new FakeLLM([req => {
  const q = JSON.parse(req.messages[0].content) as { questions: Array<{ id: string; label: string }> }
  return JSON.stringify({ answers: q.questions.map(x => ({ id: x.id, value: map[x.label] ?? '', confidence: 0.6, experiences_used: ['推荐系统重构'] })) })
}])
