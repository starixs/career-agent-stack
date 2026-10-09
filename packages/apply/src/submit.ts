import type { HandoffReason } from '@career/core'
import type { PageLike } from './page.js'
import { extractFields } from './extract.js'
import { pageSignalsScript, type ButtonInfo, type PageSignals } from './scripts.js'
import { detectObstacle, isSubmitText } from './guards.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'
import { diffAgainstPlan, type FilledRecord } from './drive.js'
import { normKey } from './interpret.js'

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
}

export const SUBMIT_SUCCESS_RX = /(投递成功|提交成功|申请成功|报名成功|已成功投递|已成功提交|已投递|已提交|感谢(您|你)的(投递|申请|关注)|我们已收到(您|你)的(简历|申请)|简历已发送|application (has been )?(submitted|received)|thank(s| you) for (applying|your application)|successfully (submitted|applied))/i

export async function submitApplication(page: PageLike, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const log = opts.log ?? (() => {})
  const shot = () => page.screenshot().catch(() => undefined)
  const base = { edits: [] as SubmitEdit[], missingRequired: [] as string[], errors: [] as string[] }

  const fields = await extractFields(page)
  const missing = fields.filter(f => f.required && (f.type === 'checkbox' ? f.value !== 'true' : !(f.value ?? '').trim())).map(f => f.label)
  const edits: SubmitEdit[] = (opts.filled?.length ? diffAgainstPlan(fields, opts.filled) : [])
    .filter(m => m.actual !== undefined && (m.actual ?? '').trim() !== '')
    .map(m => ({ label: m.label, before: m.expected, after: m.actual ?? '' }))
  if (missing.length) {
    return { ...base, status: 'needs_user', message: `还有 ${missing.length} 个必填项是空的，没有提交：${missing.slice(0, 5).join('、')}`, edits, missingRequired: missing, finalUrl: page.url(), screenshot: await shot() }
  }

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
  for (let waited = 0; waited <= timeout; waited += poll) {
    await page.waitForTimeout(poll)
    let sig: PageSignals
    try { sig = await page.evaluate(pageSignalsScript) } catch { continue } // 跳转中
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
