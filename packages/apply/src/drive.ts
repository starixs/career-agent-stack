import type { LLM, HandoffReason } from '@career/core'
import { basename } from 'node:path'
import type { PageLike } from './page.js'
import { extractFields, formFingerprint, radioOptionSelector, type FormField } from './extract.js'
import { interpretForm, normKey, type FieldPlan, type Profile, type InterpretOptions } from './interpret.js'
import { pageSignalsScript, type PageSignals, type ButtonInfo } from './scripts.js'
import { detectObstacle, isNextText, isSubmitText } from './guards.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'
import type { RiskGuard } from './safety.js'
import { humanDelay, typeLikeHuman, type PacingOptions } from './pacing.js'
import { fillLoginForm, type LoginCredential } from './login.js'

/**
 * 多页单步驱动循环：每页 extract → interpret → 上传优先 → 填写 → 差异核对 → 找"下一步"。
 * 动作集里没有"提交"：命中 SUBMIT_RX 的按钮一律不点，停下并截图，返回 stopped_before_submit。
 * 验证码 / 登录墙 / 滑块 / 2FA / 测评 → handoff（reason 对齐 core 的 HandoffReason）。
 */
export type DriveStatus = 'stopped_before_submit' | 'handoff' | 'blocked' | 'failed'

export interface FilledRecord { fieldId: string; label: string; value: string; source: FieldPlan['source'] }
export interface Mismatch { fieldId: string; label: string; expected: string; actual?: string }
export interface UploadCheck { fieldId: string; file: string; echoed: boolean; evidence?: string }
export interface PageRecord {
  index: number
  url: string
  fieldCount: number
  filled: FilledRecord[]
  needsUser: FieldPlan[]
  drafts: FieldPlan[]
  mismatches: Mismatch[]
  uploads: UploadCheck[]
  errors: string[]
  nextButton?: string
}
export interface DriveResult {
  status: DriveStatus
  /** handoff 时的原因；blocked 时可能是 missing_info。 */
  reason?: HandoffReason
  message: string
  pages: PageRecord[]
  filled: FilledRecord[]
  needsUser: FieldPlan[]
  drafts: FieldPlan[]
  mismatches: Mismatch[]
  uploads: UploadCheck[]
  /** 停在哪个提交按钮前（文案）。 */
  submitButton?: string
  /** 登录接管时，私密库已代填了哪些登录字段（不含值）。 */
  loginFilled?: Array<'username' | 'password'>
  screenshot?: Uint8Array
  finalUrl: string
  adapterId: string
}

export interface DriveOptions extends PacingOptions {
  /** 最多走几页。 */
  maxPages?: number
  adapter?: SiteAdapter
  riskGuard?: RiskGuard
  /** 页面动作之间的停顿（毫秒区间）。测试里给 [0,0]。 */
  pause?: [number, number]
  /** 逐字输入（更像真人，慢）。 */
  humanTyping?: boolean
  /** 点击下一步后等待页面稳定的毫秒数。 */
  settleMs?: number
  interpret?: InterpretOptions
  /**
   * 填写前把计划值里的私密库占位符（{{vault:profile.phone}} 等）换成明文。
   * 由 ApplyService 用 Vault.resolve 提供；模型侧产出的草稿里只会出现占位符。
   */
  resolveValue?: (value: string) => string
  /**
   * 遇到登录墙时按 URL 取账号密码（来自私密库，不经过模型）。返回 undefined 则直接接管。
   * 只代填不点登录；验证码 / 滑块 / 短信码仍由用户本人完成。
   */
  loginFill?: (url: string) => Promise<LoginCredential | undefined> | LoginCredential | undefined
  onPage?: (rec: PageRecord) => void
  log?: (msg: string) => void
}

export async function driveApplication(page: PageLike, llm: LLM, profile: Profile, opts: DriveOptions = {}): Promise<DriveResult> {
  const maxPages = opts.maxPages ?? 6
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const pause = opts.pause ?? [300, 900]
  const log = opts.log ?? (() => {})
  const pages: PageRecord[] = []
  const all = { filled: [] as FilledRecord[], needsUser: [] as FieldPlan[], drafts: [] as FieldPlan[], mismatches: [] as Mismatch[], uploads: [] as UploadCheck[] }
  const finish = async (status: DriveStatus, message: string, extra: Partial<DriveResult> = {}): Promise<DriveResult> => {
    let screenshot: Uint8Array | undefined
    try { screenshot = await page.screenshot() } catch { /* 截图失败不影响结果 */ }
    return { status, message, pages, ...all, screenshot, finalUrl: page.url(), adapterId: adapter.id, ...extra }
  }
  const shot = () => page.screenshot().catch(() => undefined)
  let lastFingerprint = ''

  try {
    if (adapter.preprocess) await adapter.preprocess(page).catch(e => log(`预处理失败：${e instanceof Error ? e.message : e}`))
    for (let index = 1; index <= maxPages; index++) {
      // 0. 风险锁 / 页数上限
      if (opts.riskGuard) {
        const s = opts.riskGuard.shouldStop()
        if (s.stop) return finish('blocked', `风险守卫要求停止：${s.reason}${s.detail ? '（' + s.detail + '）' : ''}`)
        if (!opts.riskGuard.reservePage()) return finish('blocked', '今日页数上限已到')
      }
      // 1. 阻碍检测
      let sig = await page.evaluate(pageSignalsScript)
      const risk = opts.riskGuard?.inspect(sig, adapter) ?? null
      const ob = detectObstacle(sig, adapter)
      if (risk && risk.reason === 'rate_limit') return finish('blocked', `平台限流提示：${risk.evidence}，已上风险锁`)
      if (ob) {
        if (ob.reason === 'login' && opts.loginFill) {
          const cred = await opts.loginFill(page.url())
          if (cred && (cred.username || cred.password)) {
            try {
              const r = await fillLoginForm(page, cred)
              if (r.filled.length) {
                const what = r.filled.map(k => (k === 'username' ? '账号' : '密码')).join('和')
                log(`登录页：已从私密库代填${what}`)
                return finish('handoff', `需要你本人登录：已代填${what}，请点击登录并完成验证码 / 短信验证${r.skipped.length ? '（' + r.skipped.join('；') + '）' : ''}`, { reason: 'login', loginFilled: r.filled })
              }
              log(`登录页：私密库有账号但没找到输入框（${r.skipped.join('；')}）`)
            } catch (e) { log(`登录页代填失败：${e instanceof Error ? e.message : String(e)}`) }
          }
        }
        return finish('handoff', `需要你本人处理：${ob.reason}（${ob.evidence}）`, { reason: ob.reason })
      }

      // 2. 抽取
      let fields = await extractFields(page)
      const fp = formFingerprint(page.url(), fields)
      if (index > 1 && fp === lastFingerprint) {
        return finish('blocked', `点击下一步后页面没有变化${sig.errors.length ? '，页面提示：' + sig.errors.join('；') : ''}`, { reason: 'missing_info' })
      }
      lastFingerprint = fp
      if (!fields.length) {
        if (index === 1) return finish('blocked', '页面上没有可填写的表单字段')
        break // 后续页没字段：可能到了确认页
      }
      const rec: PageRecord = { index, url: page.url(), fieldCount: fields.length, filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], errors: [] }
      log(`第 ${index} 页：${fields.length} 个字段`)

      // 3. 解释
      const plans = await interpretForm(llm, fields, profile, { adapter, ...opts.interpret })
      // 占位符 → 明文只发生在这里（Node 侧），之后的填写 / 核对都用明文；回传模型前由 ApplyService 再脱敏
      if (opts.resolveValue) for (const p of plans) if (p.status === 'fill' && p.value !== undefined) p.value = opts.resolveValue(p.value)
      const byId = new Map(fields.map(f => [f.id, f]))

      // 4. 先上传简历（上传后页面可能自动解析填充，再重新抽取）
      let uploaded = false
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (!f || !f.isFile || p.status !== 'fill' || !p.value) continue
        try {
          await page.setInputFiles(f.selector, p.value)
          await humanDelay(pause[0] * 2, pause[1] * 2, opts)
          const check = await checkUploadEcho(page, f, p.value)
          rec.uploads.push(check)
          rec.filled.push({ fieldId: f.id, label: f.label, value: basename(p.value), source: p.source })
          uploaded = true
          log(`上传 ${basename(p.value)}：${check.echoed ? '页面已回显' : '未看到回显'}`)
        } catch (e) {
          rec.uploads.push({ fieldId: f.id, file: p.value, echoed: false, evidence: `上传失败：${e instanceof Error ? e.message : String(e)}` })
        }
      }
      if (uploaded) { fields = await extractFields(page); for (const f of fields) byId.set(f.id, f) }

      // 5. 批量填写（只填与当前值不同的；高影响缺答案 / 草稿不填）
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (!f) continue
        if (p.status === 'needs_user') { rec.needsUser.push(p); continue }
        if (p.status === 'draft_needs_confirm') { rec.drafts.push(p); continue }
        if (f.isFile || p.status !== 'fill' || p.value === undefined) continue
        if (sameValue(f, p.value)) { rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source }); continue }
        try {
          await fillField(page, f, p.value, opts)
          rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source })
          await humanDelay(pause[0], pause[1], opts)
        } catch (e) {
          rec.mismatches.push({ fieldId: f.id, label: f.label, expected: p.value, actual: `填写失败：${e instanceof Error ? e.message : String(e)}` })
        }
      }

      // 6. 差异核对：重新抽取，比对计划值；只修差异字段，最多修一次
      const after = await extractFields(page)
      const diffs = diffAgainstPlan(after, rec.filled.filter(r => !byId.get(r.fieldId)?.isFile))
      for (const d of diffs) {
        const f = after.find(x => x.id === d.fieldId)
        if (!f) { rec.mismatches.push(d); continue }
        try { await fillField(page, f, d.expected, opts) } catch { /* 下面再核对一次 */ }
      }
      if (diffs.length) {
        const again = await extractFields(page)
        rec.mismatches.push(...diffAgainstPlan(again, rec.filled.filter(r => !byId.get(r.fieldId)?.isFile)))
      }
      sig = await page.evaluate(pageSignalsScript)
      rec.errors = sig.errors
      // 填写过程中可能触发验证码
      const ob2 = detectObstacle(sig, adapter)
      if (ob2) { pushPage(); opts.riskGuard?.inspect(sig, adapter); return finish('handoff', `填写过程中出现需要你本人处理的情况：${ob2.reason}（${ob2.evidence}）`, { reason: ob2.reason }) }

      // 7. 找按钮：提交一律不点；有"下一步"就点
      const submit = sig.buttons.find(b => isSubmitText(b.text, adapter))
      const next = sig.buttons.find(b => !b.disabled && isNextText(b.text, adapter))
      if (!next) {
        pushPage()
        const msg = submit ? `已停在提交按钮「${submit.text}」前，等待你本人确认提交` : '表单已填完，页面上没有找到下一步或提交按钮，请人工检查'
        return finish('stopped_before_submit', msg, { submitButton: submit?.text, reason: submit ? 'submit_confirm' : undefined })
      }
      rec.nextButton = next.text
      pushPage()
      await clickButton(page, next, adapter)
      await page.waitForTimeout(opts.settleMs ?? 800)
      await humanDelay(pause[0], pause[1], opts)

      function pushPage() { pages.push(rec); all.filled.push(...rec.filled); all.needsUser.push(...rec.needsUser); all.drafts.push(...rec.drafts); all.mismatches.push(...rec.mismatches); all.uploads.push(...rec.uploads); opts.onPage?.(rec) }
    }
    // 走完页数上限还没见到提交按钮
    const sig = await page.evaluate(pageSignalsScript)
    const submit = sig.buttons.find(b => isSubmitText(b.text, adapter))
    if (submit) return finish('stopped_before_submit', `已停在提交按钮「${submit.text}」前，等待你本人确认提交`, { submitButton: submit.text, reason: 'submit_confirm' })
    return finish('blocked', `已走完 ${maxPages} 页仍未到提交页，停止以免失控`)
  } catch (e) {
    const screenshot = await shot()
    return { status: 'failed', message: `网申驱动异常：${e instanceof Error ? e.message : String(e)}`, pages, ...all, screenshot, finalUrl: page.url(), adapterId: adapter.id }
  }
}

/** 点击前最后一道防线：文案像提交就拒绝。 */
async function clickButton(page: PageLike, b: ButtonInfo, adapter: SiteAdapter): Promise<void> {
  if (isSubmitText(b.text, adapter)) throw new Error(`拒绝点击提交类按钮「${b.text}」`)
  await page.click(b.selector)
}

async function fillField(page: PageLike, f: FormField, value: string, opts: DriveOptions): Promise<void> {
  switch (f.type) {
    case 'select': {
      if (f.custom) {
        if (page.keyboard) { await page.locator(f.selector).click(); await page.keyboard.type(value); await page.keyboard.press('Enter') }
        else await page.fill(f.selector, value)
        return
      }
      try { await page.selectOption(f.selector, { label: value }) } catch { await page.selectOption(f.selector, value) }
      return
    }
    case 'radio': await page.click(radioOptionSelector(f, value)); return
    case 'checkbox': { const want = /^(true|1|yes|是)$/i.test(value); if ((f.value === 'true') !== want) await page.click(f.selector); return }
    case 'file': await page.setInputFiles(f.selector, value); return
    default:
      if (opts.humanTyping) await typeLikeHuman(page, f.selector, value, opts)
      else await page.fill(f.selector, value)
  }
}

function sameValue(f: FormField, v: string): boolean {
  if (f.value === undefined || f.value === '') return false
  if (f.type === 'checkbox') return (f.value === 'true') === /^(true|1|yes|是)$/i.test(v)
  return normKey(f.value) === normKey(v)
}

/** 比对"页面现在的值"与"计划值"。 */
export function diffAgainstPlan(fields: FormField[], filled: FilledRecord[]): Mismatch[] {
  const out: Mismatch[] = []
  for (const r of filled) {
    const f = fields.find(x => x.id === r.fieldId)
    if (!f) { out.push({ fieldId: r.fieldId, label: r.label, expected: r.value, actual: undefined }); continue }
    if (!sameValue(f, r.value)) out.push({ fieldId: f.id, label: f.label, expected: r.value, actual: f.value })
  }
  return out
}

/** 上传后读取页面回显：文件名出现在字段值或页面文本里，或出现"上传成功/解析完成"类提示。 */
export async function checkUploadEcho(page: PageLike, f: FormField, filePath: string): Promise<UploadCheck> {
  const name = basename(filePath)
  const fields = await extractFields(page)
  const cur = fields.find(x => x.id === f.id)
  if (cur?.value && cur.value.includes(name)) return { fieldId: f.id, file: name, echoed: true, evidence: `字段值：${cur.value}` }
  const sig: PageSignals = await page.evaluate(pageSignalsScript)
  if (sig.text.includes(name)) return { fieldId: f.id, file: name, echoed: true, evidence: '页面文本中出现文件名' }
  const m = sig.text.match(/(上传成功|已上传|解析成功|解析完成|简历解析|uploaded|attached|upload complete)/i)
  if (m) return { fieldId: f.id, file: name, echoed: true, evidence: m[0] }
  return { fieldId: f.id, file: name, echoed: false, evidence: '页面没有出现文件名或上传成功提示，请人工确认附件' }
}
