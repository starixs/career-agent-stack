import { describe, it, expect } from 'vitest'
import { buildCorpus, cnToNumber, extractNumbers, findFabrications } from '../src/index.js'
import { sampleClaims, sampleResume } from './fixture.js'

describe('编造检测：中文数字 / 中文专名 / 头衔', () => {
  it('中文数字与阿拉伯数字、万 / 亿量级、百分之几统一成数值', () => {
    expect(cnToNumber('三百二十')).toBe(320)
    expect(cnToNumber('两万五千')).toBe(25000)
    expect(cnToNumber('十二')).toBe(12)
    expect(extractNumbers('覆盖 300 万日活')).toEqual(['3000000'])
    expect(extractNumbers('覆盖三百万日活')).toEqual(['3000000'])
    expect(extractNumbers('提升百分之三十')).toEqual(['30'])
    expect(extractNumbers('1.5万条')).toEqual(['15000'])
    // "一个""两次"太常见，不算数字
    expect(extractNumbers('完成一个项目，开了两次会')).toEqual([])
  })

  it('改写里换成中文写法的同一个数不报；新编的中文数字要报', () => {
    const corpus = buildCorpus(sampleResume(), sampleClaims())
    expect(findFabrications('用 Python 搭建留存分析看板，覆盖三百万日活用户', corpus).filter(f => f.kind === 'number')).toEqual([])
    const flags = findFabrications('带领五十人团队，使转化率提升百分之四十', corpus).map(f => f.token)
    expect(flags).toEqual(expect.arrayContaining(['五十', '百分之四十']))
  })

  it('原文没有的中文机构名与头衔要报；原文里有的不报', () => {
    const corpus = buildCorpus(sampleResume(), sampleClaims())
    expect(findFabrications('在某电商科技有限公司维护用户行为数据库', corpus)).toEqual([])
    const tokens = findFabrications('曾在腾讯科技有限公司担任数据组负责人', corpus).map(f => f.token)
    expect(tokens.some(t => t.includes('腾讯'))).toBe(true)
    expect(tokens).toContain('负责人')
    // 领导力说法同样要有出处
    expect(findFabrications('带领团队完成周度复盘', corpus).map(f => f.token)).toContain('带领')
    // 原文里有"部长"（统计学会学术部部长）
    expect(findFabrications('担任学术部部长，组织工作坊', corpus).map(f => f.token)).not.toContain('部长')
  })
})
