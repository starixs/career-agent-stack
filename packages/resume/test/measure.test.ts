import { describe, it, expect } from 'vitest'
import { wrapText, measureText, packSegments, charWidthEm, CLASSIC_CN } from '../src/index.js'

describe('measure / wrapText', () => {
  it('宽度：CJK 1em、Times 西文按 AFM', () => {
    expect(charWidthEm('中')).toBe(1000)
    expect(charWidthEm('i')).toBe(278)
    expect(charWidthEm('W', true)).toBe(1000)
    expect(measureText('中文', 10)).toBe(20)
    expect(measureText('ab', 10)).toBeCloseTo(9.44)
  })
  it('中文逐字可断、西文单词不拆、行首禁则生效', () => {
    const lines = wrapText('这是一段测试文本，用来验证换行，English words stay whole。', 100, 10, { safety: 0 })
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) {
      expect(measureText(l, 10)).toBeLessThanOrEqual(100 + 10) // 禁则可能带下一个字，允许 1em 的回退
      expect(l.startsWith('，')).toBe(false)
      expect(l.startsWith('。')).toBe(false)
    }
    expect(lines.join('').replace(/ /g, '')).toBe('这是一段测试文本，用来验证换行，Englishwordsstaywhole。') // 内容不丢（断行处的空格被吃掉）
    expect(lines.some(l => /English words stay whole/.test(l) || /stay whole/.test(l) || /English/.test(l))).toBe(true)
    expect(lines.every(l => !/Engl$/.test(l))).toBe(true) // 没有拆词
  })
  it('硬换行保留；超长西文单词硬拆；packSegments 在分隔符处分行', () => {
    expect(wrapText('第一行\n第二行', 500, 10)).toEqual(['第一行', '第二行'])
    const long = 'A'.repeat(200)
    expect(wrapText(long, 100, 10, { safety: 0 }).every(l => measureText(l, 10) <= 100)).toBe(true)
    const packed = packSegments(['13800000000', 'zhangsan@example.com', '上海', '求职意向：数据分析实习生'], '  |  ', 150, 10)
    expect(packed.length).toBeGreaterThan(1)
    expect(packed.every(l => !l.endsWith('|') && !l.startsWith('|'))).toBe(true)
    expect(CLASSIC_CN.contentWidth).toBeCloseTo(552.76, 1)
  })
})
