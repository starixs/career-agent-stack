import { describe, it, expect } from 'vitest'
import { FakeLLM } from '@career/core'
import { normalizeField, type Profile } from '../src/index.js'
import { resolveRangeValues } from '../src/range-fallback.js'
import { profile } from './helpers.js'

const f = (id: string, label: string) => normalizeField({ id, label, type: 'text', required: true })
const p: Profile = { ...profile, education: [{ school: '华东理工大学', degree: '本科', start: '2023-09', end: '2027-06' }] }

describe('起止格子分区没填上的兜底：不交给人，按所在经历 / 模型认出是哪一段', () => {
  it('前面有学校名：按这一段经历填，先出现的是开始、后出现的是结束；实习那一对按公司名对上', () => {
    const fields = [f('a', '学校名称'), f('b', '起止时间'), f('c', '起止时间'), f('d', '公司名称'), f('e', '起止时间'), f('g', '起止时间')]
    const ranges = new Set(['b', 'c', 'e', 'g'])
    return resolveRangeValues(fields, ranges, ranges, p).then(r => {
      expect(r).toEqual([
        { fieldId: 'b', value: '2023-09', via: 'anchor' }, { fieldId: 'c', value: '2027-06', via: 'anchor' },
        { fieldId: 'e', value: '2025.03', via: 'anchor' }, { fieldId: 'g', value: '2025.08', via: 'anchor' },
      ])
    })
  })

  it('前面没有锚字段：交模型判断属于哪一段（开始 / 结束仍按出现顺序），模型出错不抛', async () => {
    const fields = [f('x', '学历'), f('b', '起止时间'), f('c', '起止时间')]
    const ranges = new Set(['b', 'c'])
    const llm = new FakeLLM([JSON.stringify({ pairs: [{ first: 'b', period: 0 }] })])
    expect(await resolveRangeValues(fields, ranges, ranges, p, llm)).toEqual([{ fieldId: 'b', value: '2023-09', via: 'model' }, { fieldId: 'c', value: '2027-06', via: 'model' }])
    expect(String(llm.calls[0].messages[0].content)).toContain('【b】起止时间')
    const gaps: string[] = []
    expect(await resolveRangeValues(fields, ranges, ranges, p, new FakeLLM([]), m => gaps.push(m))).toEqual([])
    expect(gaps[0]).toContain('[apply-gap]')
  })
})
