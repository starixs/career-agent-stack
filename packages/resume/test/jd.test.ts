import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { parseJd, jdKeywordList } from '../src/index.js'

const reply = JSON.stringify({
  company: '示例科技', title: '数据分析实习生', location: '上海', degree: '本科', cohort: '2026 届', deadline: '',
  hard_requirements: ['本科及以上', '熟练 SQL'], responsibilities: ['搭建看板'], nice_to_have: ['Tableau'], notes: [],
  keywords: { covered: ['SQL'], diggable: ['Tableau'], missing: ['Spark'] },
  analysis: { file_naming: '姓名-学校-岗位', function_family: '数据分析', industry: '电商', company_type: '互联网', audience: 'HR 与业务负责人', hard_skills: ['SQL', 'Python'], action_verbs: ['搭建', '输出'], domain_terms: ['留存', 'GMV'], style_signals: ['优先：有电商经验'], top_keywords: ['SQL', 'Python', '看板', 'Tableau', 'Spark'], risks: [] },
})

describe('parseJd', () => {
  it('从 FakeLLM 的 JSON 回复得到 JdParsed + analysis，提示词为中文且要求 JSON', async () => {
    const llm = new FakeLLM(['```json\n' + reply + '\n```'])
    const jd = await parseJd(llm, '岗位：数据分析实习生……', { candidate: '张三，会 SQL 与 Python' })
    expect(jd.company).toBe('示例科技')
    expect(jd.location).toEqual(['上海'])
    expect(jd.keywords).toEqual({ covered: ['SQL'], diggable: ['Tableau'], missing: ['Spark'] })
    expect(jd.analysis.file_naming).toBe('姓名-学校-岗位')
    expect(jd.analysis.top_keywords).toHaveLength(5)
    expect(jd.deadline).toBeUndefined()
    expect(llm.calls[0].json).toBe(true)
    expect(llm.calls[0].system).toContain('九类信息')
    expect(llm.calls[0].messages[0].content).toContain('候选人材料')
    expect(jdKeywordList(jd)).toContain('GMV')
  })
  it('没有候选人材料时关键词全部归入 missing', async () => {
    const llm = new FakeLLM([reply])
    const jd = await parseJd(llm, 'JD 文本')
    expect(jd.keywords.covered).toEqual([])
    expect(jd.keywords.missing.sort()).toEqual(['SQL', 'Spark', 'Tableau'].sort())
    expect(jd.notes).toContain('未提供候选人材料，关键词未做三分类')
  })
  it('空 JD 直接报错', async () => {
    await expect(parseJd(new FakeLLM([]), '  ')).rejects.toThrow('JD 原文为空')
  })
})
