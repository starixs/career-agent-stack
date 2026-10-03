import { describe, it, expect } from 'vitest'
import { detectDateStyle, formatDate, matchOption, monthIndex, normalizeDegree, normalizeGender, normalizePolitics, normalizeValueForField, parseLooseDate } from '../src/index.js'

describe('字典归一（quillfill semantic-map）', () => {
  it('学历 / 性别 / 政治面貌同义词 → 标准写法；不认识的原样返回', () => {
    expect(normalizeDegree('硕士研究生')).toBe('硕士')
    expect(normalizeDegree('全日制本科')).toBe('本科')
    expect(normalizeDegree('Master')).toBe('硕士')
    expect(normalizeDegree('PhD')).toBe('博士')
    expect(normalizeDegree('高职')).toBe('大专')
    expect(normalizeDegree('在读')).toBe('在读')
    expect(normalizeGender('male')).toBe('男'); expect(normalizeGender('女性')).toBe('女')
    expect(normalizePolitics('团员')).toBe('共青团员'); expect(normalizePolitics('党员')).toBe('中共党员'); expect(normalizePolitics('预备党员')).toBe('中共预备党员')
  })
  it('选项匹配：资料写「硕士」，选项是「硕士研究生」也能选中；月份中英互认；最短包含优先', () => {
    expect(matchOption(['大学本科', '硕士研究生', '博士研究生'], '硕士', { key: 'degree' })).toBe('硕士研究生')
    expect(matchOption(['本科', '硕士', '博士'], 'Master', { label: '最高学历' })).toBe('硕士')
    expect(matchOption(['Male', 'Female'], '男', { key: 'gender' })).toBe('Male')
    expect(matchOption(['中共党员', '共青团员', '群众'], '团员', { label: '政治面貌' })).toBe('共青团员')
    expect(matchOption(['Jan', 'Feb', 'Mar'], '3月')).toBe('Mar')
    expect(matchOption(['上海市', '上海市浦东新区'], '上海')).toBe('上海市')
    expect(matchOption(['北京', '天津'], '广州')).toBeUndefined()
  })
  it('日期：宽松解析 + 按 placeholder / type 推断格式', () => {
    expect(parseLooseDate('2025.03')).toEqual({ y: 2025, m: 3, d: undefined })
    expect(parseLooseDate('2025年3月')).toEqual({ y: 2025, m: 3, d: undefined })
    expect(parseLooseDate('2024-06-15')).toEqual({ y: 2024, m: 6, d: 15 })
    expect(parseLooseDate('至今')).toBeNull()
    expect(detectDateStyle('YYYY/MM')).toBe('YYYY/MM'); expect(detectDateStyle('如 2024-06')).toBe('YYYY-MM'); expect(detectDateStyle(undefined, 'date')).toBe('YYYY-MM-DD'); expect(detectDateStyle('2023年06月')).toBe('YYYY年MM月')
    expect(formatDate('2025.3', 'YYYY/MM')).toBe('2025/03'); expect(formatDate('2025.3', 'YYYY年MM月')).toBe('2025年03月'); expect(formatDate('2025-03-01', 'YYYY.MM.DD')).toBe('2025.03.01')
    expect(monthIndex('Sept')).toBe(9); expect(monthIndex('十二月')).toBe(12); expect(monthIndex('abc')).toBeNull()
  })
  it('normalizeValueForField：学历归一 + 日期按字段整形；非日期字段不碰', () => {
    expect(normalizeValueForField('硕士研究生', { key: 'degree', label: '最高学历' })).toBe('硕士')
    expect(normalizeValueForField('2025.03', { label: '入学时间', placeholder: 'YYYY/MM' })).toBe('2025/03')
    expect(normalizeValueForField('2026-06', { key: 'graduation', label: '毕业时间', type: 'text' })).toBe('2026-06')
    expect(normalizeValueForField('2002-05-01', { label: '出生日期', type: 'date' })).toBe('2002-05-01')
    expect(normalizeValueForField('2025.03', { label: '姓名' })).toBe('2025.03')
    expect(normalizeValueForField('至今', { label: '结束时间', placeholder: 'YYYY-MM' })).toBe('至今')
  })
})
