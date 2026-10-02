import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import jsonpatch from 'fast-json-patch'
import { tailorResume, bulletRelevance, fitToPages, estimateLines, listBullets, findFabrications, buildCorpus, heuristicRelevance } from '../src/index.js'
import { sampleResume, sampleClaims, sampleJd } from './fixture.js'

const { applyPatch, validate } = jsonpatch

describe('tailorResume', () => {
  it('只把已确认主张放进提示词；产出合法 JSON Patch；应用 patch 等于 proposed', async () => {
    const llm = new FakeLLM([JSON.stringify({
      changes: [
        { op: 'replace', path: '/experience/0/bullets/1', original: '用 Python 搭建留存分析看板，覆盖 300 万日活用户', value: '用 Python 搭建留存分析看板，覆盖 300 万日活用户，支撑 A/B 实验结论输出', claim_ids: ['clm_b'], reason: '对齐 JD 的看板与 A/B 实验关键词' },
        { op: 'reorder', path: '/skills/0/keywords', value: ['SQL', 'Python', 'Excel'], reason: 'SQL 在 JD 里更靠前' },
        { op: 'replace', path: '/basics/objective', original: '数据分析实习生', value: '数据分析实习生（示例科技）', reason: '贴合岗位名' },
      ],
      strategy_notes: '围绕看板与实验',
    })])
    const master = sampleResume()
    const r = await tailorResume(llm, { master, jd: sampleJd(), claims: sampleClaims(), strength: 'keywords' })
    const prompt = llm.calls[0].messages[0].content
    expect(prompt).toContain('clm_a')
    expect(prompt).toContain('clm_d')
    expect(prompt).not.toContain('clm_pending')
    expect(prompt).not.toContain('5000 万')
    expect(r.usableClaims.map(c => c.id)).not.toContain('clm_pending')
    expect(r.excludedClaims).toBe(1)
    expect(r.patch).toHaveLength(3)
    expect(validate(r.patch, master)).toBeUndefined()
    const applied = applyPatch(structuredClone(master), r.patch, true, false).newDocument
    expect(applied).toEqual(r.proposed)
    expect(r.proposed.experience[0].bullets[1]).toContain('A/B 实验')
    expect(r.proposed.skills[0].keywords).toEqual(['SQL', 'Python', 'Excel'])
    expect(r.rationale.every(x => x.reason.length > 0)).toBe(true)
    expect(r.truthfulnessFlags).toEqual([])
    expect(r.strategyNotes).toBe('围绕看板与实验')
    // master 没被修改
    expect(master.skills[0].keywords).toEqual(['Python', 'SQL', 'Excel'])
  })

  it('标出编造的数字与名词；rejectFlagged 时直接丢弃', async () => {
    const mk = () => new FakeLLM([JSON.stringify({ changes: [
      { op: 'replace', path: '/projects/0/bullets/0', original: '清洗 8 万条订单数据，建立 SQL 分析流程', value: '清洗 80 万条订单数据，用 Spark 建立分析流程', claim_ids: ['clm_c'], reason: '对齐 Spark' },
    ] })])
    const r = await tailorResume(mk(), { master: sampleResume(), jd: sampleJd(), claims: sampleClaims(), strength: 'nudge' })
    expect(r.patch).toHaveLength(1)
    expect(r.truthfulnessFlags.map(f => `${f.kind}:${f.token}`).sort()).toEqual(['number:80', 'term:spark'])
    expect(r.truthfulnessFlags[0].path).toBe('/projects/0/bullets/0')
    const strict = await tailorResume(mk(), { master: sampleResume(), jd: sampleJd(), claims: sampleClaims(), strength: 'nudge', rejectFlagged: true })
    expect(strict.patch).toHaveLength(0)
    expect(strict.rejected[0].reason).toContain('疑似编造')
    expect(strict.proposed).toEqual(sampleResume())
  })

  it('按强度拒绝越权操作、拒绝原文不符与未引用主张的新增', async () => {
    const changes = [
      { op: 'add', path: '/experience/0/bullets', value: '用 Tableau 做 2 个可视化仪表盘', claim_ids: ['clm_d'], reason: 'JD 加分项' },
      { op: 'replace', path: '/experience/0/bullets/0', original: '这不是原文', value: '改写', reason: 'x' },
      { op: 'replace', path: '/basics/name', original: '张三', value: '李四', reason: '越权' },
      { op: 'remove', path: '/experience/0/bullets/2', original: '参与 3 次 A/B 实验设计与结论输出', reason: '弱相关' },
      { op: 'add', path: '/projects/0/bullets', value: '新增但没有主张', claim_ids: [], reason: 'x' },
    ]
    const kw = await tailorResume(new FakeLLM([JSON.stringify({ changes })]), { master: sampleResume(), jd: sampleJd(), claims: sampleClaims(), strength: 'keywords' })
    expect(kw.patch).toHaveLength(0)
    expect(kw.rejected.map(r => r.reason)).toEqual(expect.arrayContaining([expect.stringContaining('不允许 add'), expect.stringContaining('original 与简历原文不一致'), expect.stringContaining('路径不在允许范围内'), expect.stringContaining('不允许 remove')]))
    const full = await tailorResume(new FakeLLM([JSON.stringify({ changes })]), { master: sampleResume(), jd: sampleJd(), claims: sampleClaims(), strength: 'full' })
    expect(full.patch.map(p => p.op)).toEqual(['add', 'remove'])
    expect(full.proposed.experience[0].bullets).toHaveLength(3) // +1 -1
    expect(full.proposed.experience[0].bullets.at(-1)).toContain('Tableau')
    expect(full.proposed.experience[0].claim_ids).toContain('clm_d')
    expect(full.truthfulnessFlags).toEqual([]) // Tableau 与 2 都来自已确认主张
    expect(full.rejected.find(r => r.path === '/projects/0/bullets')?.reason).toContain('至少一条已确认主张')
  })

  it('findFabrications 识别数字与拉丁名词、放过语料里有的', () => {
    const corpus = buildCorpus(sampleResume(), sampleClaims())
    expect(findFabrications('覆盖 300 万日活，用 Python 与 SQL', corpus)).toEqual([])
    const flags = findFabrications('提升 45% 转化，用 Hadoop 处理', corpus)
    expect(flags.map(f => f.token)).toEqual(['45', 'hadoop'])
  })
})

describe('bulletRelevance / fitToPages', () => {
  it('bulletRelevance 读取模型分数，缺失的走启发式', async () => {
    const r = sampleResume(); const jd = sampleJd()
    const bullets = listBullets(r)
    const llm = new FakeLLM([JSON.stringify({ scores: [{ path: bullets[0].path, score: 91 }, { path: bullets[1].path, score: 140 }] })])
    const scores = await bulletRelevance(llm, bullets, jd)
    expect(scores[0]).toMatchObject({ score: 91, source: 'llm' })
    expect(scores[1].score).toBe(100)
    expect(scores[2].source).toBe('heuristic')
    expect(heuristicRelevance('用 SQL 与 Python 搭建看板，覆盖 300 万用户', jd)).toBeGreaterThan(heuristicRelevance('组织春游', jd))
  })
  it('fitToPages 按预算删掉低分 bullet，优先保留高分，不动字号', () => {
    const r = sampleResume()
    // 塞满：给实习经历加很多长 bullet
    for (let i = 0; i < 30; i++) r.experience[0].bullets.push(`无关内容第 ${i} 条：协助整理会议纪要与日常行政事务，内容较长以便占据版面空间，用于测试裁剪逻辑是否正确工作`)
    const before = estimateLines(r)
    expect(before).toBeGreaterThan(50)
    const scores = listBullets(r).map(b => ({ path: b.path, text: b.text, score: b.text.includes('无关') ? 5 : 90, source: 'heuristic' as const }))
    const fit = fitToPages(r, 1, { scores })
    expect(fit.fits).toBe(true)
    expect(fit.estimatedLines).toBeLessThanOrEqual(50)
    expect(fit.removed.length).toBeGreaterThan(0)
    expect(fit.removed.every(x => x.text.includes('无关'))).toBe(true)
    expect(fit.resume.experience[0].bullets).toContain('用 Python 搭建留存分析看板，覆盖 300 万日活用户')
    expect(fit.resume.projects[0].bullets).toHaveLength(2)
    // 原对象不被修改
    expect(r.experience[0].bullets.length).toBe(33)
  })
  it('内容本来就够短时不裁剪', () => {
    const fit = fitToPages(sampleResume(), 1)
    expect(fit.removed).toEqual([])
    expect(fit.resume).toEqual(sampleResume())
  })
})
