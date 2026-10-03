import { normKey, fuzzyEquals } from './text.js'

/**
 * 字典归一（借鉴 quillfill semantic-map）：资料里的值 → 网申表单接受的写法。
 *  - 学历 / 性别 / 政治面貌 / 婚姻：同义词字典，选项匹配时双向归一；
 *  - 日期：按字段 placeholder / 类型 / 已有示例推断格式（YYYY-MM、YYYY/MM、YYYY.MM、YYYY年MM月、带日的三种）；
 *  - 月份下拉：中英文月份名互认。
 */
export const DEGREE_DICT: Record<string, string[]> = {
  '高中': ['高中', '中专', '高中及以下', 'high school'],
  '大专': ['大专', '专科', '大学专科', '高职', '高职高专', 'college', 'associate'],
  '本科': ['本科', '大学本科', '学士', '统招本科', '全日制本科', 'bachelor', 'undergraduate', 'b.s.', 'b.a.'],
  '硕士': ['硕士', '研究生', '硕士研究生', '学术硕士', '专业硕士', 'master', 'm.s.', 'm.a.', 'graduate'],
  'MBA': ['mba', '工商管理硕士', 'emba'],
  '博士': ['博士', '博士研究生', 'doctor', 'phd', 'ph.d.', 'doctoral'],
}
export const GENDER_DICT: Record<string, string[]> = { '男': ['男', '男性', 'male', 'm', '先生'], '女': ['女', '女性', 'female', 'f', '女士'] }
export const POLITICS_DICT: Record<string, string[]> = {
  '中共党员': ['中共党员', '党员', '正式党员', 'cpc member', 'party member'],
  '中共预备党员': ['中共预备党员', '预备党员'],
  '共青团员': ['共青团员', '团员', '中国共产主义青年团团员'],
  '群众': ['群众', '普通居民', '无党派', '无', 'none'],
  '民主党派': ['民主党派', '民主党派人士'],
}
export const MARITAL_DICT: Record<string, string[]> = { '未婚': ['未婚', '单身', 'single', 'unmarried'], '已婚': ['已婚', 'married'], '离异': ['离异', '离婚', 'divorced'] }

const DICTS: Record<string, Record<string, string[]>> = { degree: DEGREE_DICT, gender: GENDER_DICT, politics: POLITICS_DICT, political_status: POLITICS_DICT, marital: MARITAL_DICT }
const LABEL_DICT_RX: Array<[RegExp, string]> = [[/学历|学位|degree|education level/i, 'degree'], [/性别|gender|sex/i, 'gender'], [/政治面貌|political/i, 'politics'], [/婚姻|婚否|marital/i, 'marital']]

/** 字典归一：返回标准写法；不在字典里原样返回。 */
export function normalizeByDict(dict: Record<string, string[]>, raw: string): string {
  const r = normKey(raw)
  if (!r) return raw
  for (const [std, variants] of Object.entries(dict)) {
    if (variants.some(v => normKey(v) === r)) return std
  }
  // 包含匹配：最长命中优先，避免「本科」命中「博士研究生」之类
  let best: { std: string; len: number } | null = null
  for (const [std, variants] of Object.entries(dict)) for (const v of variants) {
    const nv = normKey(v)
    if (nv.length >= 2 && r.includes(nv) && (!best || nv.length > best.len)) best = { std, len: nv.length }
  }
  return best?.std ?? raw
}
export const normalizeDegree = (raw: string) => normalizeByDict(DEGREE_DICT, raw)
export const normalizeGender = (raw: string) => normalizeByDict(GENDER_DICT, raw)
export const normalizePolitics = (raw: string) => normalizeByDict(POLITICS_DICT, raw)
/** 按资料键或字段标签挑字典。 */
export function dictFor(key: string | undefined, label: string | undefined): Record<string, string[]> | undefined {
  if (key && DICTS[key]) return DICTS[key]
  for (const [rx, k] of LABEL_DICT_RX) if (label && rx.test(label)) return DICTS[k]
  return undefined
}

// ---------- 日期 ----------
export type DateStyle = 'YYYY-MM' | 'YYYY/MM' | 'YYYY.MM' | 'YYYY年MM月' | 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYY.MM.DD' | 'YYYY年MM月DD日' | 'YYYYMM'
export const DATE_FIELD_RX = /(时间|日期|年月|生日|出生|毕业|入学|入职|离职|到岗|起止|date|birth|graduat|start|end)/i
export const ONGOING_RX = /^(至今|现在|今|present|now|current|ongoing)$/i

export function parseLooseDate(raw: string): { y: number; m?: number; d?: number } | null {
  const s = raw.trim()
  if (!s || ONGOING_RX.test(s)) return null
  // 2025 / 2025-03 / 2025.3 / 2025年3月 / 2024-06-15 / 2025年3月15日
  const m = s.match(/^(\d{4})\s*(?:[-/.年]\s*(\d{1,2})\s*月?)?\s*(?:[-/.]?\s*(\d{1,2})\s*日?)?$/)
  if (m) return { y: +m[1], m: m[2] ? +m[2] : undefined, d: m[3] ? +m[3] : undefined }
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})?$/)
  if (compact) return { y: +compact[1], m: +compact[2], d: compact[3] ? +compact[3] : undefined }
  const en = s.match(/^([A-Za-z]{3,})\.?\s+(\d{4})$/)
  if (en) { const mi = monthIndex(en[1]); if (mi) return { y: +en[2], m: mi } }
  return null
}

/** 从 placeholder / 示例值 / input type 推断日期格式。 */
export function detectDateStyle(hint: string | undefined, type?: string): DateStyle | null {
  if (type === 'date') return 'YYYY-MM-DD'
  if (type === 'month') return 'YYYY-MM'
  const h = (hint ?? '').trim()
  if (!h) return null
  const t = h.toUpperCase()
  if (/YYYY年MM月DD日|\d{4}年\d{1,2}月\d{1,2}日/.test(t)) return 'YYYY年MM月DD日'
  if (/YYYY年MM月|\d{4}年\d{1,2}月/.test(t)) return 'YYYY年MM月'
  if (/YYYY-MM-DD|\d{4}-\d{2}-\d{2}/.test(t)) return 'YYYY-MM-DD'
  if (/YYYY\/MM\/DD|\d{4}\/\d{2}\/\d{2}/.test(t)) return 'YYYY/MM/DD'
  if (/YYYY\.MM\.DD|\d{4}\.\d{2}\.\d{2}/.test(t)) return 'YYYY.MM.DD'
  if (/YYYY-MM|\d{4}-\d{2}(?!\d)/.test(t)) return 'YYYY-MM'
  if (/YYYY\/MM|\d{4}\/\d{2}(?!\d)/.test(t)) return 'YYYY/MM'
  if (/YYYY\.MM|\d{4}\.\d{2}(?!\d)/.test(t)) return 'YYYY.MM'
  if (/^YYYYMM$|^\d{6}$/.test(t)) return 'YYYYMM'
  return null
}

export function formatDate(raw: string, style: DateStyle): string {
  const p = parseLooseDate(raw)
  if (!p) return raw
  const mm = String(p.m ?? 1).padStart(2, '0'), dd = String(p.d ?? 1).padStart(2, '0')
  switch (style) {
    case 'YYYY-MM': return `${p.y}-${mm}`
    case 'YYYY/MM': return `${p.y}/${mm}`
    case 'YYYY.MM': return `${p.y}.${mm}`
    case 'YYYY年MM月': return `${p.y}年${mm}月`
    case 'YYYYMM': return `${p.y}${mm}`
    case 'YYYY-MM-DD': return `${p.y}-${mm}-${dd}`
    case 'YYYY/MM/DD': return `${p.y}/${mm}/${dd}`
    case 'YYYY.MM.DD': return `${p.y}.${mm}.${dd}`
    case 'YYYY年MM月DD日': return `${p.y}年${mm}月${dd}日`
  }
}

export const MONTH_NAMES: readonly (readonly string[])[] = [
  ['一月', '1月', '01', '1', 'jan', 'january'], ['二月', '2月', '02', '2', 'feb', 'february'], ['三月', '3月', '03', '3', 'mar', 'march'],
  ['四月', '4月', '04', '4', 'apr', 'april'], ['五月', '5月', '05', '5', 'may'], ['六月', '6月', '06', '6', 'jun', 'june'],
  ['七月', '7月', '07', '7', 'jul', 'july'], ['八月', '8月', '08', '8', 'aug', 'august'], ['九月', '9月', '09', '9', 'sep', 'sept', 'september'],
  ['十月', '10月', '10', '10', 'oct', 'october'], ['十一月', '11月', '11', '11', 'nov', 'november'], ['十二月', '12月', '12', '12', 'dec', 'december'],
]
export function monthIndex(text: string): number | null {
  const t = normKey(text)
  for (let i = 0; i < MONTH_NAMES.length; i++) if (MONTH_NAMES[i].some(n => normKey(n) === t)) return i + 1
  return null
}

export interface FieldHint { key?: string; label?: string; options?: string[]; placeholder?: string; type?: string; sample?: string }

/** 资料值 → 适合该字段的写法（字典归一 + 日期格式）。 */
export function normalizeValueForField(value: string, hint: FieldHint): string {
  let v = value.trim()
  const dict = dictFor(hint.key, hint.label)
  if (dict) v = normalizeByDict(dict, v)
  const looksDate = hint.type === 'date' || hint.type === 'month' || /date/i.test(hint.key ?? '') || DATE_FIELD_RX.test(`${hint.key ?? ''} ${hint.label ?? ''}`) || DATE_FIELD_RX.test(hint.placeholder ?? '')
  if (looksDate && parseLooseDate(v)) {
    const style = detectDateStyle(hint.placeholder, hint.type) ?? detectDateStyle(hint.sample) ?? (parseLooseDate(v)!.d ? 'YYYY-MM-DD' : 'YYYY-MM')
    v = formatDate(v, style)
  }
  return v
}

/**
 * 选项匹配：精确 → 字典归一后相等 → 月份名 → 选项包含值（取最短选项，最精确）→ 值包含选项 → 模糊相等。
 */
export function matchOption(options: string[], value: string | undefined, hint: FieldHint = {}): string | undefined {
  if (!value || !options.length) return undefined
  const v = normKey(value)
  const exact = options.find(o => normKey(o) === v)
  if (exact) return exact
  const dict = dictFor(hint.key, hint.label)
  if (dict) {
    const std = normalizeByDict(dict, value)
    const hit = options.find(o => normalizeByDict(dict, o) === std && std !== o && normalizeByDict(dict, o) !== o) ?? options.find(o => normalizeByDict(dict, o) === std)
    if (hit) return hit
  }
  const mi = monthIndex(value)
  if (mi) { const hit = options.find(o => monthIndex(o) === mi); if (hit) return hit }
  const containing = options.filter(o => normKey(o).includes(v) && v.length >= 1).sort((a, b) => a.length - b.length)
  if (containing.length) return containing[0]
  const contained = options.filter(o => { const n = normKey(o); return n.length >= 2 && v.includes(n) }).sort((a, b) => b.length - a.length)
  if (contained.length) return contained[0]
  return options.find(o => fuzzyEquals(o, value))
}
