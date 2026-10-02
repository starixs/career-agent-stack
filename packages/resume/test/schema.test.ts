import { describe, it, expect } from 'vitest'
import { emptyResume, parseResume, ResumeSchema, listBullets, resumeText, orderedSections, periodText } from '../src/index.js'
import { sampleResume } from './fixture.js'

describe('schema', () => {
  it('emptyResume 全默认且通过校验', () => {
    const r = emptyResume()
    expect(r.version).toBe(1)
    expect(r.basics.name).toBe('')
    expect(r.experience).toEqual([])
    expect(ResumeSchema.safeParse(r).success).toBe(true)
  })
  it('parseResume 补默认值、保留 claim_ids，非法输入抛中文错误', () => {
    const r = sampleResume()
    expect(r.experience[0].claim_ids).toEqual(['clm_a', 'clm_b'])
    expect(r.experience[0].roles).toEqual([])
    expect(r.section_order[0]).toBe('education')
    expect(() => parseResume({ experience: [{ bullets: 'not-an-array' }] })).toThrow(/简历数据不合法/)
  })
  it('listBullets 给出 JSON Pointer 路径，resumeText 包含全部文本', () => {
    const r = sampleResume()
    const bullets = listBullets(r)
    expect(bullets.map(b => b.path)).toContain('/experience/0/bullets/2')
    expect(bullets.find(b => b.path === '/custom_sections/0/items/0/bullets/0')?.text).toContain('工作坊')
    expect(resumeText(r)).toContain('复旦大学')
    expect(resumeText(r)).not.toContain('clm_a')
    expect(orderedSections({ ...r, section_order: ['skills'] })).toEqual(['skills', 'education', 'experience', 'projects', 'awards', 'certifications', 'custom_sections'])
    expect(periodText('2024.07', '')).toBe('2024.07 - 至今')
  })
})
