import { createHash } from 'node:crypto'
import type { PageLike } from './page.js'
import { extractFields, type FormField } from './extract.js'
import { pageSignalsScript, type PageSignals } from './scripts.js'
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
export type ReviewStatus = 'ok' | 'empty' | 'mismatch' | 'needs_user' | 'draft' | 'site_error' | 'upload_unconfirmed'
export interface ReviewRow {
  fieldId?: string
  label: string
  required: boolean
  status: ReviewStatus
  /** 填进去的值（已脱敏由调用方负责）。 */
  value?: string
  source?: FilledRecord['source']
  reason?: string
}
export interface SubmitReview {
  rows: ReviewRow[]
  /** 需要人看的条数（status ≠ ok）。 */
  attention: number
  requiredTotal: number
  requiredFilled: number
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
  const rows: ReviewRow[] = []
  const seen = new Set<string>()
  const add = (row: ReviewRow) => { const k = row.fieldId ?? `${row.status}:${row.label}`; if (seen.has(k)) return; seen.add(k); rows.push(row) }

  for (const m of all.mismatches) add({ fieldId: m.fieldId, label: m.label, required: !!fields.find(f => f.id === m.fieldId)?.required, status: 'mismatch', value: m.expected, reason: `页面上是「${m.actual ?? '空'}」，没有生效` })
  for (const p of all.needsUser) add({ fieldId: p.fieldId, label: p.label, required: true, status: 'needs_user', reason: p.note ?? '需要你来填' })
  for (const p of all.drafts) add({ fieldId: p.fieldId, label: p.label, required: !!fields.find(f => f.id === p.fieldId)?.required, status: 'draft', value: p.value, source: 'draft', reason: '开放题草稿，确认后才会填' })
  for (const u of all.uploads) if (!u.echoed) add({ fieldId: u.fieldId, label: `附件：${u.file}`, required: true, status: 'upload_unconfirmed', reason: u.evidence ?? '页面没有出现上传成功提示' })
  // 当前页：必填但为空（含驱动没碰过的字段）
  for (const f of fields) {
    if (seen.has(f.id)) continue
    const empty = f.type === 'checkbox' ? f.required && f.value !== 'true' : !(f.value ?? '').trim()
    const filled = all.filled.find(r => r.fieldId === f.id)
    if (f.required && empty) add({ fieldId: f.id, label: f.label, required: true, status: 'empty', reason: '必填项还是空的' })
    else add({ fieldId: f.id, label: f.label, required: f.required, status: 'ok', value: filled?.value ?? f.value, source: filled?.source })
  }
  // 前几页填过、当前页看不到的字段：按驱动记录算 ok
  for (const r of all.filled) if (!seen.has(r.fieldId)) add({ fieldId: r.fieldId, label: r.label, required: false, status: 'ok', value: r.value, source: r.source })
  for (const e of sig?.errors ?? []) add({ label: e, required: true, status: 'site_error', reason: '网站提示的校验错误' })

  const openAnswers = all.filled.filter(isOpenAnswer).map(r => ({ label: r.label, value: r.value }))
  const required = rows.filter(r => r.required && r.status !== 'site_error')
  return {
    rows,
    attention: rows.filter(r => r.status !== 'ok').length,
    requiredTotal: required.length,
    requiredFilled: required.filter(r => r.status === 'ok').length,
    formSignature: formSignatureOf(sig?.url ?? page.url(), fields),
    openAnswers,
    openAnswersHash: openAnswersHashOf(openAnswers),
  }
}
