import { describe, expect, it } from 'vitest'

import { displayMatches } from '../src/fill.js'
import { diffAgainstPlan } from '../src/drive.js'

// 真机：邮箱被键入成 "…qq,com"，页面提示格式错误，但核验去掉了标点、记成填写成功（假成功）。
describe('自由文本核验不放过标点差异', () => {
  const email = { label: '邮箱', type: 'text' as const }

  it('句号变逗号不算填对；全角半角与多余空白可以忽略', () => {
    expect(displayMatches('lin27@qq,com', 'lin27@qq.com', email)).toBe(false)
    expect(displayMatches('lin27@qq.com', 'lin27@qq.com', email)).toBe(true)
    expect(displayMatches('ｌｉｎ２７＠ｑｑ．ｃｏｍ', 'lin27@qq.com', email)).toBe(true)
    expect(displayMatches('  张  三 ', '张 三', { label: '姓名', type: 'text' })).toBe(true)
  })

  it('选项类仍按同义 / 去标点宽松比（硕士 ↔ 硕士研究生）', () => {
    expect(displayMatches('硕士研究生', '硕士', { label: '学历', type: 'select' })).toBe(true)
  })

  it('整页复核也按严格规则报出不一致', () => {
    const fields = [{ id: 'f1', label: '邮箱', type: 'text', value: 'lin27@qq,com', selector: '#e', required: true }] as never
    const out = diffAgainstPlan(fields, [{ fieldId: 'f1', label: '邮箱', value: 'lin27@qq.com' }] as never)
    expect(out).toHaveLength(1)
  })
})
