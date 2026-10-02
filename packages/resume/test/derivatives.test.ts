import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { coverEmail, shortPitch, emailSubject, clampChars } from '../src/index.js'
import { sampleResume, sampleJd } from './fixture.js'

describe('derivatives', () => {
  it('coverEmail 主题按 公司-岗位-姓名-学校，正文来自模型，附件名与主题一致', async () => {
    const llm = new FakeLLM([JSON.stringify({ body: '您好，我是复旦大学统计学张三，应聘数据分析实习生。\n- 用 Python 搭建留存看板\n- 清洗 8 万条订单\n- 3 次 A/B 实验\n7 月初到岗，简历见附件。\n张三 / 复旦大学 / 13800000000' })])
    const r = await coverEmail(llm, { resume: sampleResume(), jd: sampleJd() })
    expect(r.subject).toBe('示例科技-数据分析实习生-张三-复旦大学')
    expect(r.attachment).toBe('示例科技-数据分析实习生-张三-复旦大学.pdf')
    expect(r.body).toContain('应聘数据分析实习生')
    expect(llm.calls[0].messages[0].content).toContain('7 月初到岗')
    expect(llm.calls[0].system).toContain('三个匹配点')
    expect(emailSubject(sampleResume(), { ...sampleJd(), company: undefined })).toBe('数据分析实习生-张三-复旦大学')
  })
  it('shortPitch 受字数上限约束且重要信息在前', async () => {
    const long = '应聘数据分析实习生，复旦统计学本科，用 Python 搭建覆盖 300 万日活的留存看板，清洗 8 万条订单建立 SQL 流程，参与 3 次 A/B 实验；7 月初到岗每周 4 天可实习 6 个月，简历见附件，期待进一步沟通，谢谢您的时间与关注，祝工作顺利。'
    const llm = new FakeLLM([JSON.stringify({ pitch: long })])
    const p = await shortPitch(llm, { resume: sampleResume(), jd: sampleJd(), maxChars: 80 })
    expect([...p].length).toBeLessThanOrEqual(80)
    expect(p.startsWith('应聘数据分析实习生')).toBe(true)
    expect(llm.calls[0].messages[0].content).toContain('80 字')
    expect(clampChars('短句。', 10)).toBe('短句。')
  })
})
