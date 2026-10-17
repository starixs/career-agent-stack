import type { PageLike } from './page.js'
import { extractFields, type FormField } from './extract.js'
import { normKey, type Profile } from './interpret.js'
import { pageSignalsScript, type ButtonInfo } from './scripts.js'
import { isSubmitText } from './guards.js'
import { normalizeValueForField } from './normalize.js'

/**
 * 重复分区（"表格"）：教育经历 / 实习工作经历 / 项目经历这类"一行一段、可以『添加一行』"的模块。
 * 规则（formflow playbook）：先数现有行数 → 按条目逐行填 → 不够再点"添加"→ 等新控件出现 → 只填新出现的那一行 → 再数一次。
 * 全部确定性：行的划分靠"锚字段"（学校名称 / 公司名称 / 项目名称）在 DOM 顺序里的出现位置。
 */
export type SectionKey = 'education' | 'experience' | 'project'
export interface SectionSpec { key: SectionKey; title: string; titleRx: RegExp; anchorKeys: string[]; rowAliases: Record<string, string[]> }
export type SectionEntry = Record<string, string | undefined>

// 时间类标签分区各自一套：教育用"入学 / 毕业"，工作用"入职 / 离职"，通用的"开始 / 结束"都收，但靠锚字段切行，不会串到别的分区
const GENERIC_TIME = { start: ['开始时间', '起始时间', '开始年月', '开始日期', 'start date', 'start'], end: ['结束时间', '结束年月', '结束日期', 'end date', 'end'] }
// 「在校时间」「就读时间」是起止两格共用的标签：第一格（拿到这个标签的那格）是入学，第二格一般只剩占位符「毕业时间」
const EDU_TIME = { start: ['入学时间', '入学年月', '在校时间', '就读时间', ...GENERIC_TIME.start], end: ['毕业时间', '毕业年月', ...GENERIC_TIME.end] }
const WORK_TIME = { start: ['入职时间', '入职年月', ...GENERIC_TIME.start], end: ['离职时间', '离职年月', ...GENERIC_TIME.end] }
export const SECTIONS: readonly SectionSpec[] = [
  { key: 'education', title: '教育经历', titleRx: /(教育经历|教育背景|学历信息|教育信息|学习经历|education)/i, anchorKeys: ['school'],
    rowAliases: { school: ['学校名称', '毕业院校', '院校名称', '学校', '院校', 'university', 'school'], major: ['专业名称', '所学专业', '专业', 'major'], degree: ['最高学历', '学历', '学位', 'degree'], start: EDU_TIME.start, end: EDU_TIME.end } },
  { key: 'experience', title: '实习/工作经历', titleRx: /(实习经历|工作经历|工作经验|实习\/工作|实践经历|experience|internship)/i, anchorKeys: ['org'],
    rowAliases: { org: ['公司名称', '单位名称', '机构名称', '企业名称', '公司', '单位', '机构', '企业', 'company', 'employer', 'organization'], role: ['职位名称', '岗位名称', '职位', '岗位', '职务', 'position', 'job title', 'title', 'role'], start: WORK_TIME.start, end: WORK_TIME.end, description: ['工作内容', '工作描述', '实习内容', '主要工作', '职责描述', '工作职责', '描述', 'description', 'responsibilities'] } },
  { key: 'project', title: '项目经历', titleRx: /(项目经历|项目经验|projects?)/i, anchorKeys: ['name'],
    rowAliases: { name: ['项目名称', '项目', 'project name', 'project'], role: ['项目角色', '担任角色', '角色', 'role'], start: GENERIC_TIME.start, end: GENERIC_TIME.end, description: ['项目描述', '项目内容', '项目职责', '描述', 'description'] } },
]
export const ADD_BUTTON_RX = /^(\+|＋)?\s*(添加|新增|增加|继续添加|再添加|添加一条|添加一段|add( another| more| new| row| entry)?|new)/i

/** label → 行内字段键（最长别名优先）。 */
export function matchRowField(label: string, spec: SectionSpec): string | null {
  const l = normKey(label)
  if (!l) return null
  let best: { key: string; len: number } | null = null
  for (const [key, list] of Object.entries(spec.rowAliases)) for (const a of list) {
    const na = normKey(a)
    if (na && l.includes(na) && (!best || na.length > best.len)) best = { key, len: na.length }
  }
  return best?.key ?? null
}

/**
 * 按 DOM 顺序把字段切成行：每遇到一个锚字段（学校 / 公司 / 项目名）就开新行；
 * 锚字段之前的零散字段（往往是别的分区的时间框）不算行，避免分区之间串填。
 */
export function groupRows(fields: FormField[], spec: SectionSpec): Array<Array<{ field: FormField; key: string }>> {
  const rows: Array<Array<{ field: FormField; key: string }>> = []
  let cur: Array<{ field: FormField; key: string }> | null = null
  for (const f of fields) {
    if (f.isFile) continue
    const key = matchRowField(f.label, spec)
    if (!key) continue
    if (spec.anchorKeys.includes(key)) { cur = []; rows.push(cur) }
    else if (!cur) continue
    else if (cur.some(x => x.key === key)) { cur = null; continue } // 同一键再次出现而没有新锚字段：不属于这一行
    cur.push({ field: f, key })
  }
  return rows
}

/** 简历资料 → 分区条目。 */
export function entriesFor(key: SectionKey, profile: Profile): SectionEntry[] {
  if (key === 'education') {
    const list = profile.education ?? []
    if (list.length) return list.map(e => ({ school: e.school, major: e.major, degree: e.degree, start: e.start, end: e.end }))
    const b = profile.basics
    return b.school ? [{ school: b.school, major: b.major, degree: b.degree, end: b.graduation }] : []
  }
  const split = (period?: string) => { const m = (period ?? '').split(/\s*[~～\-–—至到]\s*/); return { start: m[0] || undefined, end: m[1] || undefined } }
  if (key === 'experience') return profile.experiences.filter(e => e.org && !/课程项目|个人项目|课设|毕业设计/.test(e.org)).map(e => ({ org: e.org, role: e.role, ...split(e.period), description: e.claims.join('；') || undefined }))
  return profile.experiences.filter(e => !e.org || /课程项目|个人项目|课设|毕业设计/.test(e.org)).map(e => ({ name: e.title, role: e.role, ...split(e.period), description: e.claims.join('；') || undefined }))
}

/** 找该分区的"添加"按钮：带分区名的优先；只有一个泛用"添加"时也接受。 */
export function findAddButton(buttons: ButtonInfo[], spec: SectionSpec, adapterSubmit: (t: string) => boolean = t => isSubmitText(t)): ButtonInfo | undefined {
  const adds = buttons.filter(b => !b.disabled && ADD_BUTTON_RX.test(b.text.trim()) && !adapterSubmit(b.text))
  const specific = adds.find(b => spec.titleRx.test(b.text))
  if (specific) return specific
  const generic = adds.filter(b => !SECTIONS.some(s => s.titleRx.test(b.text)))
  return generic.length === 1 ? generic[0] : undefined
}

export interface SectionFillRecord { fieldId: string; label: string; value: string; section: SectionKey; row: number }
export interface SectionSummary { key: SectionKey; entries: number; rowsBefore: number; rowsAfter: number; filled: number; added: number; note?: string }
export interface FillSectionsOptions {
  /** 填一格；返回 false 表示没核验通过（不记成已填）。 */
  fill: (field: FormField, value: string) => Promise<void | boolean>
  /** 这一格不由分区写入（字段阶段已写过 / 计划过、标签可疑）：同一字段只写一次。 */
  skip?: (field: FormField) => boolean
  /** 每个分区开始前（过一遍障碍层）。 */
  beforeSection?: () => Promise<void>
  settleMs?: number
  maxRows?: number
  log?: (msg: string) => void
  isSubmit?: (text: string) => boolean
  /** 值里的占位符解析（私密库）。 */
  resolveValue?: (v: string) => string
}

export async function fillRepeatingSections(page: PageLike, fields: FormField[], profile: Profile, opts: FillSectionsOptions): Promise<{ sections: SectionSummary[]; filled: SectionFillRecord[]; fields: FormField[] }> {
  const summaries: SectionSummary[] = []
  const filled: SectionFillRecord[] = []
  let current = fields
  const maxRows = opts.maxRows ?? 5
  const fillRow = async (row: Array<{ field: FormField; key: string }>, entry: SectionEntry, spec: SectionSpec, rowIndex: number) => {
    for (const { field, key } of row) {
      const raw = entry[key]
      if (!raw) continue
      if (field.value && field.value.trim()) continue // 已有值（基本信息层或用户自己填的）不覆盖
      if (opts.skip?.(field)) continue
      // 占位符 → 明文，再按字段整形（学历字典、日期按 placeholder / type 推断格式）
      const value = normalizeValueForField(opts.resolveValue ? opts.resolveValue(raw) : raw, { key, label: field.label, placeholder: field.placeholder, type: field.type, options: field.options, sample: field.value })
      try {
        const ok = await opts.fill(field, field.maxLength ? value.slice(0, field.maxLength) : value)
        if (ok !== false) filled.push({ fieldId: field.id, label: field.label, value, section: spec.key, row: rowIndex })
      } catch (e) { opts.log?.(`分区「${spec.title}」第 ${rowIndex + 1} 行「${field.label}」填写失败：${e instanceof Error ? e.message : String(e)}`) }
    }
  }
  for (const spec of SECTIONS) {
    const entries = entriesFor(spec.key, profile).slice(0, maxRows)
    if (!entries.length) continue
    let rows = groupRows(current, spec)
    if (!rows.length) continue
    await opts.beforeSection?.()
    const rowsBefore = rows.length
    let added = 0
    let note: string | undefined
    const before = filled.length
    for (let i = 0; i < Math.min(rows.length, entries.length); i++) await fillRow(rows[i], entries[i], spec, i)
    while (rows.length < entries.length && rows.length < maxRows) {
      const sig = await page.evaluate(pageSignalsScript)
      const btn = findAddButton(sig.buttons, spec, opts.isSubmit)
      if (!btn) { note = `还有 ${entries.length - rows.length} 条没地方填：没有找到「添加${spec.title}」按钮`; break }
      const prevIds = new Set(current.map(f => f.id))
      opts.log?.(`分区「${spec.title}」：点击「${btn.text}」添加第 ${rows.length + 1} 行`)
      await page.click(btn.selector)
      await page.waitForTimeout(opts.settleMs ?? 600)
      current = await extractFields(page)
      const newRows = groupRows(current, spec)
      const appeared = current.some(f => !prevIds.has(f.id))
      if (newRows.length <= rows.length || !appeared) { note = `点击「${btn.text}」后没有出现新的一行，停止添加`; break }
      added++
      const idx = rows.length
      rows = newRows
      await fillRow(rows[idx], entries[idx], spec, idx)
    }
    summaries.push({ key: spec.key, entries: entries.length, rowsBefore, rowsAfter: rows.length, filled: filled.length - before, added, note })
    // 下一分区要看到这一分区填完后的当前值（"已有值不覆盖"的判断依赖它）
    if (filled.length - before > 0) current = await extractFields(page)
  }
  return { sections: summaries, filled, fields: current }
}
