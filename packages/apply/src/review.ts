import { createHash } from 'node:crypto'
import type { PageLike } from './page.js'
import { extractFields, type FormField } from './extract.js'
import { pageSignalsScript, type PageSignals } from './scripts.js'
import { formStatsScript, type FormStats } from './widgets.js'
import { reasonText, type FieldReasonCode } from './codes.js'
import { normKey, type FieldPlan } from './interpret.js'
import { normalizeHost } from './memory.js'
import type { FilledRecord, Mismatch, UploadCheck } from './drive.js'

/**
 * 填后检查：停在提交前时，把"值没生效 / 必填为空 / 站点报错 / 附件没回显 / 需要你补 / 草稿待确认"
 * 归一成审阅清单（必填与选填分组），给审核卡片逐项展示；attention 为 0 才可能免审。
 *
 * 同时给出两个指纹，供"自学习免审"判断：
 *  - formSignature：站点 + 当前页字段标签集合（与填写的值无关）——"同一个界面"；
 *  - openAnswersHash：开放题答案（草稿 / 长文本）的内容哈希——内容变了就不能沿用旧的批准。
 */
/**
 * ok：读回核验通过（或页面原本就有值）；empty_optional：选填且留空（不再标 ok；不算要人看，单独计数）；
 * unverified：写进去了但读不回来核验（视觉层伪字段），要人看。
 */
export type ReviewStatus = 'ok' | 'empty' | 'empty_optional' | 'unverified' | 'mismatch' | 'needs_user' | 'draft' | 'site_error' | 'upload_unconfirmed'
export interface ReviewRow {
  fieldId?: string
  label: string
  required: boolean
  status: ReviewStatus
  /** 原因码（needs_user / mismatch 时，见 codes.ts）。 */
  reasonCode?: FieldReasonCode
  /** 这一行的值是否读回核验通过（ok 行：引擎写入并核验 / 页面原有值；unverified 行为 false）。 */
  verified?: boolean
  /** 标签可疑的原因。 */
  labelUncertain?: string
  /** 填进去的值（已脱敏由调用方负责）。 */
  value?: string
  source?: FilledRecord['source']
  reason?: string
}
export interface SubmitReview {
  rows: ReviewRow[]
  /** 需要人看的条数（status ≠ ok 且 ≠ empty_optional）。 */
  attention: number
  requiredTotal: number
  requiredFilled: number
  /** 选填留空（status=empty_optional）的条数：不算 ok，也不算要人看。 */
  optionalEmpty: number
  /** 本次写入的值是否全部读回核验通过（有视觉层未核验的值即为 false）。 */
  verified: boolean
  /**
   * requiredTotal 是否可信：页面上看到的必填星号比认出的必填项多，或一个必填都没认出但表单不小，就是不可信——
   * 这时"必填都填了"不能当作免审依据（shell 侧门槛要看它）。
   */
  requiredTrusted: boolean
  requiredNote?: string
  formSignature: string
  openAnswers: Array<{ label: string; value: string }>
  openAnswersHash: string
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** 长文本或草稿来源的答案视为"开放题答案"。 */
export function isOpenAnswer(r: Pick<FilledRecord, 'value' | 'source'>): boolean {
  return r.source === 'draft' || (r.value ?? '').trim().length >= 30
}

export function formSignatureOf(url: string, fields: Array<Pick<FormField, 'label' | 'type'>>): string {
  const labels = [...new Set(fields.filter(f => f.type !== 'file').map(f => normKey(f.label)).filter(Boolean))].sort()
  return sha(`${normalizeHost(url)}|${labels.join('|')}`).slice(0, 24)
}

export function openAnswersHashOf(answers: Array<{ label: string; value: string }>): string {
  return sha(answers.map(a => `${normKey(a.label)}=${a.value.trim()}`).sort().join('\n'))
}

export async function buildSubmitReview(page: PageLike, all: { filled: FilledRecord[]; needsUser: FieldPlan[]; drafts: FieldPlan[]; mismatches: Mismatch[]; uploads: UploadCheck[] }): Promise<SubmitReview> {
  let fields: FormField[] = []
  let sig: PageSignals | undefined
  try { fields = await extractFields(page) } catch { /* 页面不可读时只用驱动记录 */ }
  try { sig = await page.evaluate(pageSignalsScript) } catch { /* ignore */ }
  let stats: FormStats | undefined
  try { stats = await page.evaluate(formStatsScript) } catch { /* ignore */ }
  const rows: ReviewRow[] = []
  const seen = new Set<string>()
  const add = (row: ReviewRow) => { const k = row.fieldId ?? `${row.status}:${row.label}`; if (seen.has(k)) return; seen.add(k); rows.push(row) }

  const uncertain = (id?: string) => fields.find(f => f.id === id)?.labelUncertain
  for (const m of all.mismatches) add({ fieldId: m.fieldId, label: m.label, required: !!fields.find(f => f.id === m.fieldId)?.required, status: 'mismatch', value: m.expected, reasonCode: m.code, reason: m.reason ?? (m.actual ? `页面上是「${m.actual}」，和资料对不上` : '没有生效') })
  for (const p of all.needsUser) add({ fieldId: p.fieldId, label: p.label, required: fields.find(f => f.id === p.fieldId)?.required ?? true, status: 'needs_user', reasonCode: p.code, labelUncertain: uncertain(p.fieldId), reason: p.note ?? reasonText(p.code) })
  for (const p of all.drafts) add({ fieldId: p.fieldId, label: p.label, required: !!fields.find(f => f.id === p.fieldId)?.required, status: 'draft', value: p.value, source: 'draft', reason: '开放题草稿，确认后才会填' })
  for (const u of all.uploads) if (!u.echoed) add({ fieldId: u.fieldId, label: `附件：${u.file}`, required: true, status: 'upload_unconfirmed', reason: u.evidence ?? '页面没有出现上传成功提示' })
  // 当前页：必填但为空（含驱动没碰过的字段）；选填空值单独标 empty_optional，不再算 ok
  for (const f of fields) {
    if (seen.has(f.id)) continue
    const empty = f.type === 'checkbox' ? f.value !== 'true' : !(f.value ?? '').trim()
    const filled = all.filled.find(r => r.fieldId === f.id)
    if (f.required && empty) add({ fieldId: f.id, label: f.label, required: true, status: 'empty', reason: '必填项还是空的', labelUncertain: f.labelUncertain })
    else if (empty) add({ fieldId: f.id, label: f.label, required: false, status: 'empty_optional', reason: '选填，留空', labelUncertain: f.labelUncertain })
    else if (filled && filled.verified === false) add({ fieldId: f.id, label: f.label, required: f.required, status: 'unverified', verified: false, value: filled.value, source: filled.source, reason: '写进去了但没能读回核验，请看一眼' })
    else add({ fieldId: f.id, label: f.label, required: f.required, status: 'ok', verified: true, value: filled?.value ?? f.value, source: filled?.source, labelUncertain: f.labelUncertain })
  }
  // 前几页填过、当前页看不到的字段：按驱动记录（核验过才算 ok）
  for (const r of all.filled) if (!seen.has(r.fieldId)) add({ fieldId: r.fieldId, label: r.label, required: false, status: r.verified === false ? 'unverified' : 'ok', verified: r.verified !== false, value: r.value, source: r.source, ...(r.verified === false ? { reason: '写进去了但没能读回核验，请看一眼' } : {}) })
  for (const e of sig?.errors ?? []) add({ label: e, required: true, status: 'site_error', reason: '网站提示的校验错误' })

  const openAnswers = all.filled.filter(isOpenAnswer).map(r => ({ label: r.label, value: r.value }))
  const required = rows.filter(r => r.required && r.status !== 'site_error')
  const detected = fields.filter(f => f.required).length
  let requiredTrusted = true
  let requiredNote: string | undefined
  if (stats && stats.markers > detected) { requiredTrusted = false; requiredNote = `页面上有 ${stats.markers} 个必填星号，只认出 ${detected} 个必填项` }
  else if (!detected && fields.filter(f => f.type !== 'file').length >= 6) { requiredTrusted = false; requiredNote = '一个必填项都没认出来，这个表单的必填标记可能没识别到' }
  return {
    rows,
    attention: rows.filter(r => r.status !== 'ok' && r.status !== 'empty_optional').length,
    requiredTotal: required.length,
    requiredFilled: required.filter(r => r.status === 'ok').length,
    optionalEmpty: rows.filter(r => r.status === 'empty_optional').length,
    verified: all.filled.every(r => r.verified !== false) && !all.mismatches.length,
    requiredTrusted,
    ...(requiredNote ? { requiredNote } : {}),
    formSignature: formSignatureOf(sig?.url ?? page.url(), fields),
    openAnswers,
    openAnswersHash: openAnswersHashOf(openAnswers),
  }
}
