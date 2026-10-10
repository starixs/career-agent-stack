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
import { looksLikeFormVisually, pairVisualFields, type Perceiver, type UiKind } from './perception.js'
import { visionScan, visionFill, visionClickText, visionFindButton, type VisionOptions } from './vision.js'
import { describeObstacle, looksLikeRiskUrl, type CaptchaKind } from './obstacles.js'
import { fillRepeatingSections, type SectionSummary } from './sections.js'
import { fillValueScript } from './scripts.js'
import { normalizeHost, type SiteMemory } from './memory.js'
import { DATE_FIELD_RX, matchOption } from './normalize.js'
import type { FieldType } from './scripts.js'
import { buildSubmitReview, type SubmitReview } from './review.js'

/**
 * 多页单步驱动循环：每页 extract → interpret → 上传优先 → 填写 → 差异核对 → 找"下一步"。
 * 动作集里没有"提交"：命中 SUBMIT_RX 的按钮一律不点，停下并截图，返回 stopped_before_submit。
 * 验证码 / 登录墙 / 滑块 / 2FA / 测评 → handoff（reason 对齐 core 的 HandoffReason）。
 *
 * 分层执行：
 *  L1 DOM 直驱（默认）；
 *  L2 视觉兜底（给了 opts.perceiver 且页面支持 mouse 时）：DOM 抽不到字段 / 填不进去 / 找不到按钮 → 截图感知 + 坐标操作；
 *  L3 交给用户（handoff），并用 describeObstacle 说清楚该做什么。
 */
export type DriveStatus = 'stopped_before_submit' | 'handoff' | 'blocked' | 'failed'
export type DriveLayer = 'dom' | 'vision'

export interface FilledRecord { fieldId: string; label: string; value: string; source: FieldPlan['source']; layer?: DriveLayer }
export interface Mismatch { fieldId: string; label: string; expected: string; actual?: string }
export interface UploadCheck { fieldId: string; file: string; echoed: boolean; evidence?: string }
/** 一次 L1 → L2 的降级记录（给用户 / 日志看"为什么走了视觉层"）。 */
export interface Escalation { reason: 'no_fields' | 'fill_mismatch' | 'no_next_button' | 'custom_select'; field?: string; outcome: 'recovered' | 'failed' | 'stopped'; evidence: string }
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
  escalations: Escalation[]
  /** 重复分区（教育 / 实习 / 项目）的逐行填写情况。 */
  sections?: SectionSummary[]
  nextButton?: string
  layer?: DriveLayer
}
export interface DriveResult {
  status: DriveStatus
  /** handoff 时的原因；blocked 时可能是 missing_info。 */
  reason?: HandoffReason
  message: string
  /** handoff 时：用户具体该做什么（给接管条展示）。 */
  userAction?: string
  captchaKind?: CaptchaKind
  pages: PageRecord[]
  filled: FilledRecord[]
  needsUser: FieldPlan[]
  drafts: FieldPlan[]
  mismatches: Mismatch[]
  uploads: UploadCheck[]
  escalations: Escalation[]
  layersUsed: DriveLayer[]
  /** 停在哪个提交按钮前（文案）。 */
  submitButton?: string
  /** 登录接管时，私密库已代填了哪些登录字段（不含值）。 */
  loginFilled?: Array<'username' | 'password'>
  /** 用户在接管期间自己填好的字段（learnFrom 里的标签），调用方可存进答案库。 */
  learned: Array<{ label: string; value: string }>
  /** 本次写进站点记忆的映射数。 */
  memorized: number
  screenshot?: Uint8Array
  finalUrl: string
  adapterId: string
  /** stopped_before_submit 时的填后检查（审阅清单 + 免审指纹）。 */
  review?: SubmitReview
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
  /** 视觉兜底层的感知器（OCR / 视觉模型）。不给则只有 DOM 层。 */
  perceiver?: Perceiver
  vision?: { maxFieldsPerPage?: number; maxScrolls?: number }
  /** 站点映射记忆：别名匹配不到的字段按上次记录直填；读回核对通过的 profile 字段记下来。 */
  siteMemory?: SiteMemory
  /** 续跑时：这些标签上次是 needs_user，若现在页面上已有值（用户自己填的），回传给调用方存进答案库。 */
  learnFrom?: string[]
  onPage?: (rec: PageRecord) => void
  log?: (msg: string) => void
}

const SUBMIT_WORDS = ['提交', '确认提交', '提交申请', '投递', '立即投递', 'Submit', 'Apply now'] as const
const NEXT_WORDS = ['下一步', '下一页', '继续', '保存并继续', '保存并下一步', 'Next', 'Continue'] as const
const KIND_TO_TYPE: Partial<Record<UiKind, FieldType>> = { input: 'text', select: 'select', checkbox: 'checkbox', radio: 'radio' }

export async function driveApplication(page: PageLike, llm: LLM, profile: Profile, opts: DriveOptions = {}): Promise<DriveResult> {
  const maxPages = opts.maxPages ?? 6
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const pause = opts.pause ?? [300, 900]
  const log = opts.log ?? (() => {})
  const pages: PageRecord[] = []
  const all = { filled: [] as FilledRecord[], needsUser: [] as FieldPlan[], drafts: [] as FieldPlan[], mismatches: [] as Mismatch[], uploads: [] as UploadCheck[], escalations: [] as Escalation[], learned: [] as Array<{ label: string; value: string }>, memorized: 0 }
  const host = normalizeHost(page.url())
  const recallKey = opts.siteMemory ? opts.siteMemory.recaller(host) : undefined
  /** 页内执行器（框架适配 / React 安全赋值）；失败返回 false，调用方再走其他路。 */
  const actuate = async (f: FormField, value: string, kind: 'auto' | 'text' | 'select' | 'date' | 'richtext' = 'auto'): Promise<boolean> => {
    try {
      const r = await page.evaluate(fillValueScript, { selector: f.selector, value, kind, fieldKey: `${f.label} ${f.name ?? ''}` })
      if (r.ok) log(`页内执行器：「${f.label}」← ${r.strategy}`)
      return r.ok
    } catch { return false }
  }
  const layersUsed = new Set<DriveLayer>()
  const visionOpts: VisionOptions | null = opts.perceiver && page.mouse
    ? { perceiver: opts.perceiver, maxScrolls: opts.vision?.maxScrolls, pause: [Math.min(pause[0], 200), Math.min(pause[1], 500)], typeDelayMs: pause[1] === 0 ? 0 : undefined, log, rng: opts.rng, sleep: opts.sleep }
    : null
  const finish = async (status: DriveStatus, message: string, extra: Partial<DriveResult> = {}): Promise<DriveResult> => {
    let screenshot: Uint8Array | undefined
    try { screenshot = await page.screenshot() } catch { /* 截图失败不影响结果 */ }
    // 停在提交前：做一遍填后检查，给审核卡片的审阅清单与免审判断
    let review: SubmitReview | undefined
    if (status === 'stopped_before_submit') { try { review = await buildSubmitReview(page, all) } catch { /* 检查失败时调用方按"需要人看"处理 */ } }
    return { status, message, pages, ...all, layersUsed: [...layersUsed], screenshot, finalUrl: page.url(), adapterId: adapter.id, ...(review ? { review } : {}), ...extra }
  }
  const handoff = (reason: HandoffReason, sig: PageSignals, evidence: string, prefix: string, extra: Partial<DriveResult> = {}) => {
    const d = describeObstacle(reason, sig, evidence, { loginFilled: extra.loginFilled })
    return finish('handoff', `${prefix}${reason}（${evidence}）。${d.userAction}`, { reason, userAction: d.userAction, captchaKind: d.kind, ...extra })
  }
  const shot = () => page.screenshot().catch(() => undefined)
  /**
   * 一路下来没碰到任何表单项：那个"提交类"按钮其实是岗位详情页的申请入口（立即申请 / 投递简历），不是网申表的提交。
   * 入口按钮也可能是一键投递，所以照样不点；交给用户点进去（多半要登录），交还后从那一页接着填。
   */
  const untouched = () => !all.filled.length && !all.needsUser.length && !all.drafts.length && !all.uploads.length && !all.mismatches.length
  const entryHandoff = (button: string) => finish('handoff', `这是岗位详情页，不是网申表：页面上没有可填写的字段，「${button}」是申请入口。`, {
    reason: 'login', userAction: `请在浏览器里点「${button}」进入网申（通常要先登录），看到申请表后点"交还"，我从那一页接着填`,
  })
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
      if (!ob && looksLikeRiskUrl(sig.url)) { opts.riskGuard?.trip('rate_limit', `跳转到风控页 ${sig.url}`); return finish('blocked', `被跳转到风控 / 验证页：${sig.url}，已上风险锁`) }
      if (ob) {
        if (ob.reason === 'login' && opts.loginFill) {
          const cred = await opts.loginFill(page.url())
          if (cred && (cred.username || cred.password)) {
            try {
              const r = await fillLoginForm(page, cred)
              if (r.filled.length) {
                const what = r.filled.map(k => (k === 'username' ? '账号' : '密码')).join('和')
                log(`登录页：已从私密库代填${what}`)
                return handoff('login', sig, ob.evidence, `需要你本人登录：已代填${what}${r.skipped.length ? '（' + r.skipped.join('；') + '）' : ''}；`, { loginFilled: r.filled })
              }
              log(`登录页：私密库有账号但没找到输入框（${r.skipped.join('；')}）`)
            } catch (e) { log(`登录页代填失败：${e instanceof Error ? e.message : String(e)}`) }
          }
        }
        return handoff(ob.reason, sig, ob.evidence, '需要你本人处理：')
      }

      // 2. 抽取（L1）；抽不到且有感知器 → L2 视觉伪字段
      let fields = await extractFields(page)
      let layer: DriveLayer = 'dom'
      const rec: PageRecord = { index, url: page.url(), fieldCount: fields.length, filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], errors: [], escalations: [] }
      if (!fields.length && visionOpts) {
        const p = await visionScan(page, visionOpts, '寻找表单输入框')
        if (looksLikeFormVisually(p)) {
          const vf = pairVisualFields(p).slice(0, opts.vision?.maxFieldsPerPage ?? 40)
          fields = vf.map(v => ({ id: v.id, label: v.label, type: KIND_TO_TYPE[v.kind] ?? 'text', options: [], required: false, isFile: false, isRichText: false, custom: v.kind === 'select', selector: `vision:${v.id}`, layer: 'vision', box: v.element.box } satisfies FormField))
          layer = 'vision'
          rec.fieldCount = fields.length
          rec.escalations.push({ reason: 'no_fields', outcome: 'recovered', evidence: `DOM 抽不到字段，截图感知到 ${fields.length} 个输入框（${p.source}）` })
          log(`第 ${index} 页：DOM 抽不到字段，切到视觉层（${fields.length} 个输入框）`)
        } else {
          rec.escalations.push({ reason: 'no_fields', outcome: 'failed', evidence: `截图感知也没看到表单（${p.elements.length} 个元素）` })
        }
      }
      const fp = formFingerprint(page.url(), fields)
      if (index > 1 && fp === lastFingerprint) {
        return finish('blocked', `点击下一步后页面没有变化${sig.errors.length ? '，页面提示：' + sig.errors.join('；') : ''}`, { reason: 'missing_info' })
      }
      lastFingerprint = fp
      if (!fields.length) {
        if (index === 1) {
          pages.push(rec); all.escalations.push(...rec.escalations)
          const entry = sig.buttons.find(b => isSubmitText(b.text, adapter))
          return entry ? entryHandoff(entry.text) : finish('blocked', '页面上没有可填写的表单字段')
        }
        break // 后续页没字段：可能到了确认页
      }
      rec.layer = layer
      layersUsed.add(layer)
      log(`第 ${index} 页：${fields.length} 个字段（${layer}）`)
      // 续跑：用户在接管期间自己填好的字段（上次 needs_user）→ 回传给调用方存答案库
      if (index === 1 && opts.learnFrom?.length && layer === 'dom') {
        const want = new Set(opts.learnFrom.map(normKey))
        for (const f of fields) if (want.has(normKey(f.label)) && f.value && f.value.trim() && !f.isFile) all.learned.push({ label: f.label, value: f.value.trim() })
        if (all.learned.length) log(`学到 ${all.learned.length} 个用户自己填的答案：${all.learned.map(l => l.label).join('、')}`)
      }

      // 3. 解释（别名匹配不到的字段交给站点记忆回忆）
      const plans = await interpretForm(llm, fields, profile, { adapter, recallKey, ...opts.interpret })
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
          rec.filled.push({ fieldId: f.id, label: f.label, value: basename(p.value), source: p.source, layer: 'dom' })
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
        if (f.layer === 'vision') {
          const r = await visionFill(page, visionOpts!, f.label, p.value)
          if (r.ok) rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source, layer: 'vision' })
          else rec.mismatches.push({ fieldId: f.id, label: f.label, expected: p.value, actual: `视觉层填写失败：${r.evidence}` })
          await humanDelay(pause[0], pause[1], opts)
          continue
        }
        if (sameValue(f, p.value)) { rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source, layer: 'dom' }); continue }
        try {
          await fillField(page, f, p.value, opts, actuate)
          rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source, layer: 'dom' })
          await humanDelay(pause[0], pause[1], opts)
        } catch (e) {
          rec.mismatches.push({ fieldId: f.id, label: f.label, expected: p.value, actual: `填写失败：${e instanceof Error ? e.message : String(e)}` })
        }
      }

      // 5.5 重复分区（教育 / 实习工作 / 项目经历的"表格"）：逐行填，不够就点"添加一行"再填新出现的那一行（只在 DOM 层）
      if (layer === 'dom') {
        try {
          // 重新抽取：拿到第 5 步填完后的当前值，已有值的行不覆盖
          fields = await extractFields(page); for (const f of fields) byId.set(f.id, f)
          const sec = await fillRepeatingSections(page, fields, profile, {
            fill: (f, v) => fillField(page, f, v, opts, actuate), settleMs: opts.settleMs, log, isSubmit: t => isSubmitText(t, adapter), resolveValue: opts.resolveValue,
          })
          for (const f of sec.filled) rec.filled.push({ fieldId: f.fieldId, label: f.label, value: f.value, source: 'profile', layer: 'dom' })
          if (sec.sections.length) rec.sections = sec.sections
          if (sec.fields !== fields) { fields = sec.fields; for (const f of fields) byId.set(f.id, f) }
          for (const s of sec.sections) if (s.note) log(`分区「${s.key}」：${s.note}`)
        } catch (e) { log(`重复分区填写异常：${e instanceof Error ? e.message : String(e)}`) }
      }

      // 6. 差异核对（只对 DOM 层）：重新抽取，比对计划值；只修差异，最多修一次；仍不一致 → 视觉层兜底
      if (layer === 'dom') {
        const after = await extractFields(page)
        const domFilled = rec.filled.filter(r => !byId.get(r.fieldId)?.isFile)
        const diffs = diffAgainstPlan(after, domFilled)
        for (const d of diffs) {
          const f = after.find(x => x.id === d.fieldId)
          if (!f) { rec.mismatches.push(d); continue }
          // 第一次重试：页内执行器（原型链 setter / 框架适配器），不行再用 Playwright 原路径
          if (await actuate(f, d.expected, 'auto')) { rec.escalations.push({ reason: 'fill_mismatch', field: f.label, outcome: 'recovered', evidence: '页内执行器重填' }); continue }
          try { await fillField(page, f, d.expected, opts) } catch { /* 下面再核对一次 */ }
        }
        if (diffs.length) {
          let remaining = diffAgainstPlan(await extractFields(page), domFilled)
          if (remaining.length && visionOpts) {
            // L2：按标签找输入框，坐标点击 + 逐字键入，再用 DOM 读回核对
            for (const m of remaining) {
              const r = await visionFill(page, visionOpts, m.label, m.expected)
              rec.escalations.push({ reason: 'fill_mismatch', field: m.label, outcome: r.ok ? 'recovered' : 'failed', evidence: r.evidence })
              const rf = rec.filled.find(x => x.fieldId === m.fieldId); if (rf && r.ok) rf.layer = 'vision'
            }
            layersUsed.add('vision')
            remaining = diffAgainstPlan(await extractFields(page), domFilled)
            for (const e of rec.escalations) if (e.reason === 'fill_mismatch' && e.outcome === 'recovered' && remaining.some(m => m.label === e.field)) e.outcome = 'failed'
          }
          rec.mismatches.push(...remaining)
          for (const e of rec.escalations) if (e.reason === 'fill_mismatch' && e.outcome === 'recovered' && remaining.some(m => m.label === e.field)) e.outcome = 'failed'
        }
        // 站点记忆：读回核对通过的 profile 字段，记下"这站这个字段 ↔ 资料键"，下次别名匹配不到也能直填
        if (opts.siteMemory) {
          const bad = new Set(rec.mismatches.map(m => m.fieldId))
          for (const p of plans) {
            const f = byId.get(p.fieldId)
            if (!f || !p.key || p.status !== 'fill' || bad.has(p.fieldId) || !rec.filled.some(r => r.fieldId === p.fieldId)) continue
            opts.siteMemory.remember(host, { name: f.name, xpath: f.xpath, label: f.label }, p.key, p.note === '按站点记忆匹配' ? 'learned' : 'alias')
            all.memorized++
          }
        }
      }
      sig = await page.evaluate(pageSignalsScript)
      rec.errors = sig.errors
      // 填写过程中可能触发验证码
      const ob2 = detectObstacle(sig, adapter)
      if (ob2) { pushPage(); opts.riskGuard?.inspect(sig, adapter); return handoff(ob2.reason, sig, ob2.evidence, '填写过程中出现需要你本人处理的情况：') }

      // 7. 找按钮：提交一律不点；有"下一步"就点；DOM 找不到 → 视觉层找文案
      const submit = sig.buttons.find(b => isSubmitText(b.text, adapter))
      const next = sig.buttons.find(b => !b.disabled && isNextText(b.text, adapter))
      if (!next && !submit && visionOpts) {
        const submitWords = [...(adapter.hints.submitWords ?? []), ...SUBMIT_WORDS]
        const vSubmit = await visionFindButton(page, visionOpts, submitWords)
        if (vSubmit) {
          rec.escalations.push({ reason: 'no_next_button', outcome: 'stopped', evidence: `DOM 没有按钮，截图里看到提交类按钮「${vSubmit.text}」` })
          layersUsed.add('vision'); pushPage()
          if (untouched()) return entryHandoff(vSubmit.text)
          return finish('stopped_before_submit', `已停在提交按钮「${vSubmit.text}」前（视觉层识别），等待你本人确认提交`, { submitButton: vSubmit.text, reason: 'submit_confirm' })
        }
        const vNext = await visionClickText(page, visionOpts, [...(adapter.hints.nextButton ?? []), ...NEXT_WORDS], t => isSubmitText(t, adapter))
        layersUsed.add('vision')
        if (vNext.clicked) {
          rec.escalations.push({ reason: 'no_next_button', outcome: 'recovered', evidence: vNext.evidence })
          rec.nextButton = vNext.clicked.text
          pushPage()
          await page.waitForTimeout(opts.settleMs ?? 800)
          await humanDelay(pause[0], pause[1], opts)
          continue
        }
        rec.escalations.push({ reason: 'no_next_button', outcome: 'failed', evidence: vNext.refused ? vNext.evidence : vNext.evidence })
      }
      if (!next) {
        pushPage()
        if (untouched()) return submit ? entryHandoff(submit.text) : finish('blocked', '页面上没有找到可填写的网申表单，也没有下一步或提交按钮')
        const msg = submit ? `已停在提交按钮「${submit.text}」前，等待你本人确认提交` : '表单已填完，页面上没有找到下一步或提交按钮，请人工检查'
        return finish('stopped_before_submit', msg, { submitButton: submit?.text, reason: submit ? 'submit_confirm' : undefined })
      }
      rec.nextButton = next.text
      pushPage()
      await clickButton(page, next, adapter)
      await page.waitForTimeout(opts.settleMs ?? 800)
      await humanDelay(pause[0], pause[1], opts)

      function pushPage() { pages.push(rec); all.filled.push(...rec.filled); all.needsUser.push(...rec.needsUser); all.drafts.push(...rec.drafts); all.mismatches.push(...rec.mismatches); all.uploads.push(...rec.uploads); all.escalations.push(...rec.escalations); opts.onPage?.(rec) }
    }
    // 走完页数上限还没见到提交按钮
    const sig = await page.evaluate(pageSignalsScript)
    const submit = sig.buttons.find(b => isSubmitText(b.text, adapter))
    if (submit && untouched()) return entryHandoff(submit.text)
    if (submit) return finish('stopped_before_submit', `已停在提交按钮「${submit.text}」前，等待你本人确认提交`, { submitButton: submit.text, reason: 'submit_confirm' })
    return finish('blocked', `已走完 ${maxPages} 页仍未到提交页，停止以免失控`)
  } catch (e) {
    const screenshot = await shot()
    return { status: 'failed', message: `网申驱动异常：${e instanceof Error ? e.message : String(e)}`, pages, ...all, layersUsed: [...layersUsed], screenshot, finalUrl: page.url(), adapterId: adapter.id }
  }
}

/** 点击前最后一道防线：文案像提交就拒绝。 */
async function clickButton(page: PageLike, b: ButtonInfo, adapter: SiteAdapter): Promise<void> {
  if (isSubmitText(b.text, adapter)) throw new Error(`拒绝点击提交类按钮「${b.text}」`)
  await page.click(b.selector)
}

type Actuate = (f: FormField, value: string, kind?: 'auto' | 'text' | 'select' | 'date' | 'richtext') => Promise<boolean>
const isDateLike = (f: FormField) => f.type === 'date' || DATE_FIELD_RX.test(`${f.label} ${f.placeholder ?? ''}`) || /yyyy|年|月/i.test(f.placeholder ?? '')

/**
 * 填一个字段。顺序：
 *  - 自定义下拉 / 第三方日期控件：先页内执行器（antd / element / … 按框架指纹点选），再退回"点开 → 键入 → 回车"；
 *  - 原生控件：Playwright fill / selectOption / click；
 *  - 富文本：fill 不行再页内 insertText。
 */
async function fillField(page: PageLike, f: FormField, value: string, opts: DriveOptions, actuate?: Actuate): Promise<void> {
  switch (f.type) {
    case 'select': {
      if (f.custom) {
        if (actuate && await actuate(f, value, 'select')) return
        if (page.keyboard) { await page.locator(f.selector).click(); await page.keyboard.type(value); await page.keyboard.press('Enter') }
        else await page.fill(f.selector, value)
        return
      }
      try { await page.selectOption(f.selector, { label: value }) } catch { try { await page.selectOption(f.selector, value) } catch (e) { if (!actuate || !(await actuate(f, value, 'select'))) throw e } }
      return
    }
    case 'radio': await page.click(radioOptionSelector(f, value)); return
    case 'checkbox': { const want = /^(true|1|yes|是)$/i.test(value); if ((f.value === 'true') !== want) await page.click(f.selector); return }
    case 'file': await page.setInputFiles(f.selector, value); return
    case 'richtext':
      try { await page.fill(f.selector, value) } catch (e) { if (!actuate || !(await actuate(f, value, 'richtext'))) throw e }
      return
    default:
      // 第三方日期控件（antd / element / My97…）直接 fill 往往被面板吞掉：先走页内执行器
      if (actuate && f.framework && f.framework !== 'native' && isDateLike(f) && await actuate(f, value, 'date')) return
      if (opts.humanTyping) await typeLikeHuman(page, f.selector, value, opts)
      else await page.fill(f.selector, value)
  }
}

function sameValue(f: FormField, v: string): boolean {
  if (f.value === undefined || f.value === '') return false
  if (f.type === 'checkbox') return (f.value === 'true') === /^(true|1|yes|是)$/i.test(v)
  if (normKey(f.value) === normKey(v)) return true
  // 下拉：页面显示的是选项文案（"硕士研究生"），计划值可能是资料写法（"硕士"）→ 字典 / 包含匹配算一致
  if (f.type === 'select') return !!matchOption([f.value], v, { label: f.label })
  return false
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
