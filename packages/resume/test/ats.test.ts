import { describe, it, expect } from 'vitest'
import { atsCheck, renderPdf, resumeText, countPdfPages, parseResume, orderedSections, sectionTitle, type Resume } from '../src/index.js'

/** 模拟从单栏 PDF 抽出的文字：分区标题 + 内容。 */
const pdfText = (r: Resume) => [...orderedSections(r).map(k => sectionTitle(r, k)), resumeText(r)].join('\n')
import { sampleResume } from './fixture.js'

describe('过机筛自检', () => {
  it('文字完整、顺序正确：通过', () => {
    const r = sampleResume()
    const report = atsCheck(r, pdfText(r), 1)
    expect(report.ok).toBe(true)
    expect(report.issues.filter(i => i.level === 'error')).toEqual([])
    expect(report.score).toBeGreaterThanOrEqual(80)
  })

  it('读不出文字（图片简历）/ 多栏打乱顺序 / 图标字体 / 照片 / 超页数 都会指出', () => {
    const r = sampleResume()
    expect(atsCheck(r, '', 1)).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'no_text' })]) })
    // 多栏：要点被排到了所有单位名之前
    const scrambled = ['张三 13800000000 zhangsan@example.com', '用 Python 搭建留存分析看板', '维护用户行为数据库', '校园外卖订单分析', '某电商科技有限公司', resumeText(r)].join('\n').replace(/维护用户行为数据库，支撑 12 期周度复盘汇报/g, '')
    expect(atsCheck(r, scrambled, 1).issues.map(i => i.code)).toContain('order')
    expect(atsCheck(r, resumeText(r) + '', 1).issues.map(i => i.code)).toContain('icons')
    const withPhoto = parseResume({ ...r, basics: { ...r.basics, photo_url: 'file:///a.jpg' } })
    expect(atsCheck(withPhoto, resumeText(r), 3).issues.map(i => i.code)).toEqual(expect.arrayContaining(['photo', 'pages']))
  })

  it('ATS 模式能渲染（单栏、无照片）', async () => {
    const r = parseResume({ ...sampleResume(), basics: { ...sampleResume().basics, photo_url: '' } })
    const pdf = await renderPdf(r, { ats: true })
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    expect(countPdfPages(pdf)).toBeGreaterThanOrEqual(1)
  })
})
