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

describe('灰着的格子在等前一格（2026-11-02 美团：专业名称、意向城市都以「这一格是灰的」推给了用户）', () => {
  it('说清在等哪一格并标上 waitsFor；前面没有空着的格子（网站锁定）就照旧报灰', async () => {
    const { explainWaiting } = await import('../src/needs.js')
    const out = explainWaiting([
      { fieldId: 'f2', label: '意向部门', status: 'needs_user', source: 'none', confidence: 0 },
      { fieldId: 'f3', label: '意向城市', status: 'needs_user', source: 'profile', confidence: 0, code: 'field_disabled' },
      { fieldId: 'f9', label: '学院名称', status: 'needs_user', source: 'none', confidence: 0 },
      { fieldId: 'f10', label: '专业名称', status: 'needs_user', source: 'profile', confidence: 0, code: 'field_disabled' },
      { fieldId: 'f0', label: '手机号码', status: 'needs_user', source: 'profile', confidence: 0, code: 'field_disabled' },
    ])
    expect(out.map(n => [n.label, n.waitsFor ?? null])).toEqual([['意向部门', null], ['意向城市', '意向部门'], ['学院名称', null], ['专业名称', '学院名称'], ['手机号码', null]])
    expect(out[3].note).toBe('要先定「学院名称」，定了我接着填')
  })
})
