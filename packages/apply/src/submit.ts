import type { HandoffReason } from '@career/core'
import type { PageLike } from './page.js'
import { extractFields } from './extract.js'
import { pageSignalsScript, type ButtonInfo, type PageSignals } from './scripts.js'
import { detectObstacle, isSubmitText } from './guards.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'
import { diffAgainstPlan, looseName, type FilledRecord } from './drive.js'
import { uploadAreaScript } from './widgets.js'
import type { FormField } from './extract.js'
import { normKey } from './interpret.js'
import { CONSENT_RX } from './review.js'
import { verifyBeforeContinuing, type VerificationHandler } from './verification.js'

/**
 * 提交执行器：只在动作队列里的 submit 动作被批准（用户本人 / auto 模式 / 自学习免审）后由产品调用。
 * 填表驱动（driveApplication）仍然构造上不点提交；这里是唯一会点提交按钮的地方。
 *
 * 顺序：重新抽字段 → 必填为空就不提交（needs_user）→ 记下用户在页面上改过的值（edits，用于答案库学习与自学习判断）
 *      → 找提交按钮（优先批准时记下的文案）→ 点击 → 轮询结果：成功文案 / 跳转且表单消失 = submitted；
 *        出现校验错误 = failed；出现验证码等 = handoff。
 */
export type SubmitStatus = 'submitted' | 'needs_user' | 'handoff' | 'failed' | 'uncertain'
export interface SubmitEdit { label: string; before: string; after: string }
export interface SubmitResult {
  status: SubmitStatus
  message: string
  reason?: HandoffReason
  /** 成功判定的依据（页面文案 / 跳转）。 */
  evidence?: string
  button?: string
  /** 批准后用户在页面上改过的值。 */
  edits: SubmitEdit[]
  missingRequired: string[]
  errors: string[]
  /** 他批准提交时一并勾上 / 点了的「已阅读并同意…」（如实记进回执）。 */
  agreed?: string[]
  finalUrl: string
  screenshot?: Uint8Array
}
export interface SubmitOptions {
  /** 批准时停在的按钮文案（drive 结果的 submitButton）。 */
  expectedButton?: string
  /** drive 填进去的值：与页面现值比对得到 edits。 */
  filled?: FilledRecord[]
  adapter?: SiteAdapter
  /** 点击后最多等多久判定结果（毫秒）。 */
  timeoutMs?: number
  pollMs?: number
  log?: (msg: string) => void
  /** 仅由已批准的提交执行器注入；自动验证不再次点击提交。 */
  verify?: VerificationHandler
}

export const SUBMIT_SUCCESS_RX = /(投递成功|提交成功|申请成功|报名成功|已成功投递|已成功提交|已投递|已提交|感谢(您|你)的(投递|申请|关注)|我们已收到(您|你)的(简历|申请)|简历已发送|application (has been )?(submitted|received)|thank(s| you) for (applying|your application)|successfully (submitted|applied))/i

/**
 * 我们传过的附件还在不在：很多站（问卷星的上传组件）传完就把 <input type=file> 清空，只在上传区留文件名，
 * 只看 value 会把已传好的简历报成「必填项是空的」，永远交不出去（2026-11-02 中兵通信）。
 * 记下的文件名是脱敏的（{{vault:...}}-岗位-公司.pdf），按占位符以外的那段对；对不上时上传区有 .pdf/.doc 文件项也算。
 */
async function uploadStillShown(page: PageLike, f: FormField, filled: FilledRecord[] | undefined): Promise<boolean> {
  if (f.type !== 'file') return false
  const rec = filled?.find(r => r.label === f.label || r.fieldId === f.id)
  if (!rec?.value) return false
  let area: { text: string }
  try { area = await page.evaluate(uploadAreaScript, { selector: f.selector }) } catch { return false }
  const parts = rec.value.replace(/\.[a-z0-9]{2,5}$/i, '').split(/\{\{[^}]+\}\}/).map(looseName).filter(x => x.length >= 2)
  const text = looseName(area.text)
  return (parts.length > 0 && parts.every(x => text.includes(x))) || /\.(pdf|docx?)\b/i.test(area.text)
}

/**
 * 「我已阅读并同意《填答者协议》《隐私条款》」「本人承诺所填信息真实」：不勾就交不出去（问卷星点提交弹「请阅读并同意…」，2026-11-02 斯达半导体）。
 * 填表时从不勾——只在他点头批准提交的这一步勾，同意跟着他的批准走，并记进回执。
 */
const CONSENT_BUTTON_RX = /^(同意并继续|同意并提交|我同意|同意|确定同意)$/

async function tickConsents(page: PageLike, fields: FormField[]): Promise<string[]> {
  const agreed: string[] = []
  for (const f of fields.filter(x => x.type === 'checkbox' && x.value !== 'true' && CONSENT_RX.test(x.label))) {
    try { await page.click(f.selector); agreed.push(f.label) } catch { /* 勾不上就照常交，网站会说缺什么 */ }
  }
  return agreed
}

/** 点了提交后弹出的「请阅读并同意…」框：点一次「同意并继续」（同上，算在他的批准里）。 */
async function acceptConsentDialog(page: PageLike, sig: PageSignals, done: Set<string>): Promise<string | null> {
  if (!/(协议|条款|隐私|声明)/.test(sig.text)) return null
  const b = sig.buttons.find(x => CONSENT_BUTTON_RX.test(x.text.replace(/\s+/g, '')) && !x.disabled && !done.has(x.text))
  if (!b) return null
  done.add(b.text)
  try { await page.click(b.selector); return b.text } catch { return null }
}

export async function submitApplication(page: PageLike, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const log = opts.log ?? (() => {})
  const shot = () => page.screenshot().catch(() => undefined)
  const base: { edits: SubmitEdit[]; missingRequired: string[]; errors: string[]; agreed?: string[] } = { edits: [], missingRequired: [], errors: [] }

  if (opts.verify) {
    const checked = await verifyBeforeContinuing(page, await page.evaluate(pageSignalsScript), opts.verify)
    if (checked.blocked) return { ...base, status: 'handoff', reason: 'captcha', message: '提交前自动验证未完成，请在当前页处理', finalUrl: page.url(), screenshot: await shot() }
  }
  const fields = await extractFields(page)
  const empty = fields.filter(f => f.required && (f.type === 'checkbox' ? f.value !== 'true' : !(f.value ?? '').trim()))
  const missing: string[] = []
  for (const f of empty) if (!(await uploadStillShown(page, f, opts.filled))) missing.push(f.label)
  const edits: SubmitEdit[] = (opts.filled?.length ? diffAgainstPlan(fields, opts.filled) : [])
    .filter(m => m.actual !== undefined && (m.actual ?? '').trim() !== '')
    .map(m => ({ label: m.label, before: m.expected, after: m.actual ?? '' }))
  if (missing.length) {
    return { ...base, status: 'needs_user', message: `还有 ${missing.length} 个必填项是空的，没有提交：${missing.slice(0, 5).join('、')}`, edits, missingRequired: missing, finalUrl: page.url(), screenshot: await shot() }
  }

  const agreed = await tickConsents(page, fields)
  if (agreed.length) { base.agreed = agreed; log(`勾上了：${agreed.join('、')}`) }
  const before: PageSignals = await page.evaluate(pageSignalsScript)
  const ob = detectObstacle(before, adapter)
  if (ob) return { ...base, status: 'handoff', reason: ob.reason, message: `提交前出现需要你本人处理的情况：${ob.evidence}`, edits, finalUrl: page.url(), screenshot: await shot() }
  const button = pickSubmitButton(before.buttons, adapter, opts.expectedButton)
  if (!button) return { ...base, status: 'failed', message: opts.expectedButton ? `页面上找不到提交按钮「${opts.expectedButton}」` : '页面上找不到提交按钮', edits, finalUrl: page.url(), screenshot: await shot() }
  if (button.disabled) return { ...base, status: 'needs_user', message: `提交按钮「${button.text}」是灰的，页面可能还有没填好的内容`, edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }

  const urlBefore = page.url()
  const errorsBefore = new Set(before.errors)
  log(`点击提交按钮「${button.text}」`)
  await page.click(button.selector)

  const timeout = opts.timeoutMs ?? 15_000
  const poll = opts.pollMs ?? 500
  const consentClicks = new Set<string>()
  for (let waited = 0; waited <= timeout; waited += poll) {
    await page.waitForTimeout(poll)
    let sig: PageSignals
    try { sig = await page.evaluate(pageSignalsScript) } catch { continue } // 跳转中
    const accepted = await acceptConsentDialog(page, sig, consentClicks)
    if (accepted) { base.agreed = [...(base.agreed ?? []), accepted]; log(`点了「${accepted}」`); continue }
    if (opts.verify && !SUBMIT_SUCCESS_RX.test(sig.text)) {
      const checked = await verifyBeforeContinuing(page, sig, opts.verify)
      sig = checked.signals
      if (checked.blocked) return { ...base, status: 'handoff', reason: detectObstacle(sig, adapter)?.reason ?? 'captcha', message: '提交后的自动验证未完成，请处理；不要重复提交', edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }
    }
    const ok = sig.text.match(SUBMIT_SUCCESS_RX)
    if (ok) return { ...base, status: 'submitted', message: `已提交（页面提示「${ok[0]}」）`, evidence: ok[0], edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }
    const ob2 = detectObstacle(sig, adapter)
    if (ob2) return { ...base, status: 'handoff', reason: ob2.reason, message: `点提交后需要你本人处理：${ob2.evidence}`, edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }
    const newErrors = sig.errors.filter(e => !errorsBefore.has(e))
    if (newErrors.length) return { ...base, status: 'failed', message: `网站没有接受这次提交：${newErrors.slice(0, 3).join('；')}`, errors: newErrors, edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }
    if (page.url() !== urlBefore && sig.fieldCount === 0 && !sig.buttons.some(b => isSubmitText(b.text, adapter))) {
      return { ...base, status: 'submitted', message: '已提交（页面已跳转、表单已消失）', evidence: `跳转到 ${page.url()}`, edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }
    }
  }
  return { ...base, status: 'uncertain', message: '点了提交，但没等到成功提示；请到页面上确认是否已投递成功', edits, button: button.text, finalUrl: page.url(), screenshot: await shot() }
}

function pickSubmitButton(buttons: ButtonInfo[], adapter: SiteAdapter, expected?: string): ButtonInfo | undefined {
  const submits = buttons.filter(b => isSubmitText(b.text, adapter))
  if (expected) {
    const want = normKey(expected)
    const exact = submits.find(b => normKey(b.text) === want) ?? buttons.find(b => normKey(b.text) === want)
    if (exact) return exact
  }
  return submits.find(b => !b.disabled) ?? submits[0]
}
