import { describe, it, expect } from 'vitest'
import { Db, Repos, inferEmploymentType, matchJob, normalizeCohort, skillsIn, type MatchEvidence } from '../src/index.js'

const evidence: MatchEvidence[] = [
  { id: 'clm_1', kind: 'claim', text: '用 Python + pandas 清洗 200 万条订单数据，搭建周报指标体系', label: '某电商数据实习' },
  { id: 'clm_2', kind: 'claim', text: '在 Hive 上写 SQL 做留存分析，推动改版后次留提升 3pt', label: '某电商数据实习' },
]
const parsed = (o: object) => JSON.stringify(o)

describe('岗位类型 / 届别', () => {
  it('从批次与标题推断校招 / 实习 / 社招', () => {
    expect(inferEmploymentType('实习', '数据分析')).toBe('intern')
    expect(inferEmploymentType('秋招', '后端开发')).toBe('campus')
    expect(inferEmploymentType('3年以上经验')).toBe('social')
    expect(inferEmploymentType('后端开发')).toBe('unknown')
  })
  it('届别只认带届 / 毕业的写法，不把 JD 里的日期当届别', () => {
    expect(normalizeCohort('27届')).toBe('2027届')
    expect(normalizeCohort('面向2026年毕业生')).toBe('2026届')
    expect(normalizeCohort('2027')).toBe('2027届')
    expect(normalizeCohort('截止日期 2026-10-05')).toBeNull()
  })
})

describe('可解释匹配', () => {
  it('要求项对到具体经历；分数随覆盖率变化', () => {
    const m = matchJob({
      job: { title: '数据分析实习生', location: '北京', deadline: '2026-12-01', jd_raw: '', employment_type: 'intern', cohort: '2027届',
        jd_parsed_json: parsed({ hard_requirements: ['熟练使用 SQL', '熟悉 Python 数据处理', '有机器学习项目经验'], keywords: { covered: [], diggable: ['A/B 测试'], missing: [] } }) },
      prefs: { cohort: '2027届', degree: '本科', cities: ['北京'], employment_types: ['intern'] },
      evidence, today: '2026-10-10',
    })
    expect(m.hard_ok).toBe(true)
    const sql = m.requirements.find(r => r.requirement.includes('SQL'))!
    expect(sql.status).toBe('covered')
    expect(sql.evidence).toMatchObject({ id: 'clm_2', label: '某电商数据实习' })
    expect(m.requirements.find(r => r.requirement.includes('Python'))!.evidence!.id).toBe('clm_1')
    expect(m.requirements.find(r => r.requirement.includes('机器学习'))!.status).toBe('missing')
    expect(m.summary).toMatch(/4 项要求里有 2 项/)
    expect(m.score).toBeGreaterThan(40)
    expect(m.score).toBeLessThan(100)
  })

  it('违反明确条件（届别 / 城市 / 已截止 / 类型）：不推荐，分数封顶 20，并说清原因', () => {
    const base = { title: '数据分析', jd_raw: 'SQL Python', jd_parsed_json: null, employment_type: 'campus' }
    const wrongCohort = matchJob({ job: { ...base, location: '北京', deadline: null, cohort: '2026届' }, prefs: { cohort: '2027届' }, evidence })
    expect(wrongCohort.hard_ok).toBe(false)
    expect(wrongCohort.score).toBeLessThanOrEqual(20)
    expect(wrongCohort.summary).toMatch(/届别/)
    expect(matchJob({ job: { ...base, location: '深圳', deadline: null }, prefs: { cities: ['北京', '上海'] }, evidence }).hard_ok).toBe(false)
    expect(matchJob({ job: { ...base, location: '北京', deadline: '2026-10-01' }, prefs: {}, evidence, today: '2026-10-10' }).hard_ok).toBe(false)
    expect(matchJob({ job: { ...base, location: '北京', deadline: null }, prefs: { employment_types: ['intern'] }, evidence }).hard_ok).toBe(false)
    // JD 没写的条件不算违反（ok=null），只提示投前核对
    const unknown = matchJob({ job: { ...base, location: null, deadline: null }, prefs: { cohort: '2027届', cities: ['北京'] }, evidence })
    expect(unknown.hard_ok).toBe(true)
    expect(unknown.hard.every(h => h.ok === null)).toBe(true)
  })

  it('没有 JD 解析时按技能词表从原文抽要求', () => {
    expect(skillsIn('熟悉 MySQL 与 Tableau，懂一点 pytorch')).toEqual(expect.arrayContaining(['SQL', '数据分析', '深度学习']))
    const m = matchJob({ job: { title: '数据开发', location: null, deadline: null, jd_raw: '要求熟悉 Hive SQL、Linux', jd_parsed_json: null }, prefs: {}, evidence })
    expect(m.requirements.map(r => r.requirement)).toEqual(expect.arrayContaining(['SQL', 'Linux']))
    expect(m.requirements.find(r => r.requirement === 'SQL')!.status).toBe('covered')
  })
})

describe('岗位入库带类型与届别', () => {
  it('upsertJob 推断 employment_type / cohort', () => {
    const r = new Repos((() => { const db = new Db(':memory:'); db.migrate(); return db })())
    const j = r.upsertJob({ source_platform: 'manual', title: '2027届数据分析实习生', jd_raw: '面向2027届毕业生' })
    expect(j.employment_type).toBe('intern')
    expect(j.cohort).toBe('2027届')
  })
})
