import { describe, it, expect } from 'vitest'
import { settleNeedsUser } from '../src/needs.js'
import type { FieldPlan } from '../src/interpret.js'

const need = (fieldId: string, label: string, note = '无法从资料确定'): FieldPlan => ({ fieldId, label, status: 'needs_user', source: 'none', confidence: 0, note })

describe('收尾整理「要你补」', () => {
  it('同一格多轮记了几次只留一次（最新的原因）；后来已经填好的不再要他补', () => {
    const needs = [need('f4', '年龄'), need('f9', '期望工作地点', '下拉选项里没有和你的资料对得上的'), need('f4', '年龄', '新原因'), need('f5', '性别')]
    const filled = [{ fieldId: 'f9', label: '期望工作地点', verified: true }, { fieldId: 'f5', label: '性别', verified: false }]
    const out = settleNeedsUser(needs, filled)
    expect(out.map(p => `${p.fieldId}:${p.label}`)).toEqual(['f4:年龄', 'f5:性别'])
    expect(out[0].note).toBe('新原因')
  })
  it('标签相同、编号不同的是两个格子（两段教育经历各有一个「学历」）：都留着；一段填好了另一段照样要补', () => {
    const out = settleNeedsUser([need('f3', '学历'), need('f8', '学历')], [{ fieldId: 'f3', label: '学历', verified: true }])
    expect(out.map(p => p.fieldId)).toEqual(['f8'])
    expect(settleNeedsUser([need('f3', '学历'), need('f8', '学历')], []).length).toBe(2)
  })
})
