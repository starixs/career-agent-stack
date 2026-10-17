import { handoffReasonLabel, type LLM, type HandoffReason } from '@career/core'
import { basename } from 'node:path'
import type { PageLike } from './page.js'
import { extractFields, formFingerprint, type FormField } from './extract.js'
import { interpretForm, normKey, type FieldPlan, type Profile, type InterpretOptions } from './interpret.js'
import { pageSignalsScript, type PageSignals, type ButtonInfo } from './scripts.js'
import { detectObstacle, findFinalSubmit, isEntryText, isNextText, isSubmitText } from './guards.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'
import type { RiskGuard } from './safety.js'
import { humanDelay, type PacingOptions } from './pacing.js'
import { fillLoginForm, type LoginCredential } from './login.js'
import { looksLikeFormVisually, pairVisualFields, type Perceiver, type UiKind } from './perception.js'
import { visionScan, visionFill, visionClickText, visionFindButton, type VisionOptions } from './vision.js'
import { describeObstacle, looksLikeRiskUrl, type CaptchaKind } from './obstacles.js'
import { fillRepeatingSections, type SectionSummary } from './sections.js'
import { normalizeHost, type SiteMemory } from './memory.js'
import { matchOption } from './normalize.js'
import type { FieldType } from './scripts.js'
import { buildSubmitReview, type SubmitReview } from './review.js'
import { clearBlockers, type HandledBlocker } from './blockers.js'
import { displayMatches, fillAndVerify, type FieldAttempt } from './fill.js'
import { classifyError, reasonText, withWatchdog, type FieldReasonCode } from './codes.js'
import { isSensitiveLabel, noopRecorder, RunRecorder, type Recorder, type TelemetryOptions } from './telemetry.js'
import { clearHighlightScript, libraryFingerprintScript, maskSensitiveScript, prepareEntryClickScript, readDisplayScript } from './widgets.js'

/**
 * 多页单步驱动循环：每页 障碍层 → extract → interpret → 上传优先（上传后再过障碍层）→ 逐字段"填写 + 核验 + 失败回滚"
 * → 重复分区（与字段填写去重）→ 整页复核 → 找"下一步"。
 *
 * 两重机制：
 *  第一重（怎么做最好）：障碍层先清掉挡路的弹窗；自定义下拉点选项、日期面板按年月导航；标签解析排除吸顶栏；
 *    详情页上的申请入口按钮（立即申请 / 申请职位…）可以点进去；实时画面跟随正在填的那一格。
 *  第二重（兜底，宁空不错）：任何字段核验不过就清空并标 needs_user（附原因码），清不掉标 mismatch；
 *    不用原生 setter 硬写自定义控件；危险键位白名单；同一字段只写一次；最终提交类按钮任何一层都不点。
 *
 * 分层执行：L1 DOM（含页内执行器）→ L2 视觉兜底（给了 perceiver 且页面支持 mouse）→ L3 交给用户（handoff）。
 * 每次运行可写一份遥测（opts.telemetry）：trace.jsonl / 小截图 / 失败 DOM 片段 / summary.json。
 */
export type DriveStatus = 'stopped_before_submit' | 'handoff' | 'blocked' | 'failed'
export type DriveLayer = 'dom' | 'vision'

export interface FilledRecord {
  fieldId: string; label: string; value: string; source: FieldPlan['source']; layer?: DriveLayer
  /** 读回核验通过（显示值与计划值一致）。视觉层伪字段读不回 DOM，为 false。 */
  verified?: boolean
  /** 用的什么策略（type / fill / option-click / date-panel / native-select / vision …）。 */
  strategy?: string
  /** 核验时页面上的显示值。 */
  display?: string
}
export interface Mismatch {
  fieldId: string; label: string; expected: string
  /** 页面上现在显示的值（不是报错原文）。 */
  actual?: string
  code?: FieldReasonCode
  /** 给用户看的中文原因。 */
  reason?: string
}
export interface UploadCheck { fieldId: string; file: string; echoed: boolean; evidence?: string }
/** 一次 L1 → L2 的降级记录（给用户 / 日志看"为什么走了视觉层"）。 */
export interface Escalation { reason: 'no_fields' | 'fill_mismatch' | 'no_next_button' | 'custom_select'; field?: string; outcome: 'recovered' | 'failed' | 'stopped'; evidence: string }
/** 字段级最终状态（每页每个字段一条），shell 侧门槛 / 卡片 / 统计用。 */
export type FieldStatus = 'verified' | 'unverified' | 'needs_user' | 'mismatch' | 'draft' | 'empty_optional' | 'prefilled' | 'skipped'
export interface FieldOutcome {
  fieldId: string
  label: string
  page: number
  type: FieldType
  required: boolean
  /** 必填是怎么认出来的（attr / aria / class / star）；没认出为 undefined。 */
  requiredVia?: string
  status: FieldStatus
  /** 是否读回核验通过。 */
  verified: boolean
  value?: string
  display?: string
  strategy?: string
  source?: FieldPlan['source']
  /** 留空 / 失败的原因码与中文说明。 */
  code?: FieldReasonCode
  reason?: string
  /** 标签可疑的原因（导航栏文字 / 纯数字 / 太长 / 没标签）。 */
  labelUncertain?: string
  section?: string
}
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
  /** 本页处理过的弹窗。 */
  blockers?: HandledBlocker[]
  fields?: FieldOutcome[]
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
  /** 字段级最终状态（所有页）。 */
  fields: FieldOutcome[]
  /** 处理过的弹窗（障碍层）。 */
  blockers: HandledBlocker[]
  /** 从详情页点进申请表用的入口按钮文案。 */
  entryClicked?: string
  /** 识别到的组件库指纹（mtd / antd / element / beisen / moka …）。 */
  libraries: string[]
  /** 这次运行记录的位置。 */
  telemetry?: { dir: string; runId: string }
  /** failed 时的原因码（timeout / fill_error …）。 */
  failureCode?: string
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

/** 给界面的人话进度（不含内部调试信息、不含明文敏感值）。 */
export interface DriveProgress { message: string; kind: 'page' | 'field' | 'blocker' | 'upload' | 'entry' | 'section' | 'stop'; label?: string }

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
  /** 内部调试日志（不要广播给界面；会同时写进遥测）。 */
  log?: (msg: string) => void
  /** 给界面的人话进度。 */
  onProgress?: (p: DriveProgress) => void
  /** 运行记录：给目录就写 `<dir>/<runId>/`；也可以直接给一个 Recorder。 */
  telemetry?: TelemetryOptions | Recorder
  /** 每个字段的看门狗（毫秒，缺省 30 秒）；页面级脚本 25 秒。 */
  watchdogMs?: number
  /** 实时画面跟随：填写前滚到正中并高亮（缺省开）。 */
  highlight?: boolean
  /** 详情页上允许点申请入口按钮进入网申表（缺省开）。 */
  allowEntryClick?: boolean
  /** 障碍层 / 下拉候选不确定时用的模型（缺省用 driveApplication 的 llm）。 */
  widgetLlm?: LLM | null
}

const SUBMIT_WORDS = ['提交', '确认提交', '提交申请', '投递', '立即投递', 'Submit', 'Apply now'] as const
const NEXT_WORDS = ['下一步', '下一页', '继续', '保存并继续', '保存并下一步', 'Next', 'Continue'] as const
const KIND_TO_TYPE: Partial<Record<UiKind, FieldType>> = { input: 'text', select: 'select', checkbox: 'checkbox', radio: 'radio' }
const PAGE_STEP_MS = 25_000
const TEXTLIKE = new Set<FieldType>(['text', 'email', 'tel', 'number', 'textarea'])

const isRecorder = (t: DriveOptions['telemetry']): t is Recorder => !!t && typeof (t as Recorder).trace === 'function'

export async function driveApplication(page: PageLike, llm: LLM, profile: Profile, opts: DriveOptions = {}): Promise<DriveResult> {
  const maxPages = opts.maxPages ?? 6
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const pause = opts.pause ?? [300, 900]
  const host = normalizeHost(page.url())
  const recorder: Recorder = isRecorder(opts.telemetry) ? opts.telemetry : opts.telemetry ? new RunRecorder(opts.telemetry, host) : noopRecorder
  const log = (msg: string) => { opts.log?.(msg); recorder.trace({ stage: 'log', result: 'info', detail: msg }) }
  const progress = (message: string, kind: DriveProgress['kind'] = 'field', label?: string) => { opts.onProgress?.({ message, kind, label }); recorder.trace({ stage: 'progress', result: 'info', detail: message }) }
  const widgetLlm = opts.widgetLlm === null ? undefined : opts.widgetLlm ?? llm
  const pages: PageRecord[] = []
  const all = { filled: [] as FilledRecord[], needsUser: [] as FieldPlan[], drafts: [] as FieldPlan[], mismatches: [] as Mismatch[], uploads: [] as UploadCheck[], escalations: [] as Escalation[], learned: [] as Array<{ label: string; value: string }>, memorized: 0 }
  const allFields: FieldOutcome[] = []
  const allBlockers: HandledBlocker[] = []
  let libraries: string[] = []
  let entryClicked: string | undefined
  let entryClicks = 0
  const recallKey = opts.siteMemory ? opts.siteMemory.recaller(host) : undefined
  const layersUsed = new Set<DriveLayer>()
  const visionOpts: VisionOptions | null = opts.perceiver && page.mouse
    ? { perceiver: opts.perceiver, maxScrolls: opts.vision?.maxScrolls, pause: [Math.min(pause[0], 200), Math.min(pause[1], 500)], typeDelayMs: pause[1] === 0 ? 0 : undefined, log, rng: opts.rng, sleep: opts.sleep }
    : null
  let sensitive: string[] = []
  const capture = (name: string) => recorder.shot(name, async () => {
    if (sensitive.length) await page.evaluate(maskSensitiveScript, { on: true, selectors: sensitive }).catch(() => {})
    try { return await (page.screenshotSmall ? page.screenshotSmall() : page.screenshot()) } finally { if (sensitive.length) await page.evaluate(maskSensitiveScript, { on: false }).catch(() => {}) }
  })
  const step = <T,>(name: string, work: () => Promise<T>) => withWatchdog(name, PAGE_STEP_MS, work)
  /** 障碍层；返回 false 表示有处理不了的模态弹窗。 */
  let unresolvedBlocker: { text: string; buttons: string[]; reason: string } | undefined
  const blockers = async (stage: string, rec?: PageRecord): Promise<boolean> => {
    const r = await clearBlockers(page, { llm: widgetLlm, recorder, progress: m => progress(m, 'blocker'), log, settleMs: Math.min(opts.settleMs ?? 400, 600) || 0, stage })
    if (r.handled.length) { allBlockers.push(...r.handled); if (rec) (rec.blockers ??= []).push(...r.handled) }
    unresolvedBlocker = r.unresolved
    return !r.unresolved
  }
  const fillDeps = { page, pause, humanTyping: opts.humanTyping, llm: widgetLlm, recorder, progress: (m: string) => progress(m, 'field'), log, watchdogMs: opts.watchdogMs ?? 30_000, clearBlockers: () => blockers('field'), capture, highlight: opts.highlight, rng: opts.rng, sleep: opts.sleep }

  const summarize = (status: string, extra: Partial<DriveResult>) => {
    const fs = allFields
    recorder.finish({
      status, libraries, pages: pages.length, entryClicked, layersUsed: [...layersUsed],
      fields: { total: fs.length, verified: fs.filter(f => f.verified).length, needsUser: fs.filter(f => f.status === 'needs_user').length, mismatch: fs.filter(f => f.status === 'mismatch').length, emptyOptional: fs.filter(f => f.status === 'empty_optional').length, labelUncertain: fs.filter(f => f.labelUncertain).length },
      blockers: allBlockers.map(b => ({ text: b.text.slice(0, 120), choice: b.choice, by: b.by, resolved: b.resolved })),
      requiredTrusted: extra.review?.requiredTrusted,
    })
  }
  const telemetryRef = recorder.dir && recorder.runId ? { dir: recorder.dir, runId: recorder.runId } : undefined
  const finish = async (status: DriveStatus, message: string, extra: Partial<DriveResult> = {}): Promise<DriveResult> => {
    let screenshot: Uint8Array | undefined
    try { await page.evaluate(clearHighlightScript) } catch { /* ignore */ }
    try { screenshot = await page.screenshot() } catch { /* 截图失败不影响结果 */ }
    // 停在提交前：做一遍填后检查，给审核卡片的审阅清单与免审判断
    let review: SubmitReview | undefined
    if (status === 'stopped_before_submit') { try { review = await buildSubmitReview(page, all) } catch { /* 检查失败时调用方按"需要人看"处理 */ } }
    if (status === 'stopped_before_submit') progress(message, 'stop')
    const result: DriveResult = { status, message, pages, ...all, layersUsed: [...layersUsed], fields: allFields, blockers: allBlockers, entryClicked, libraries, ...(telemetryRef ? { telemetry: telemetryRef } : {}), screenshot, finalUrl: page.url(), adapterId: adapter.id, ...(review ? { review } : {}), ...extra }
    recorder.trace({ stage: 'finish', result: status === 'failed' ? 'fail' : 'info', detail: `${status}：${message}` })
    summarize(status, result)
    return result
  }
  const handoff = (reason: HandoffReason, sig: PageSignals, evidence: string, prefix: string, extra: Partial<DriveResult> = {}) => {
    const d = describeObstacle(reason, sig, evidence, { loginFilled: extra.loginFilled })
    return finish('handoff', `${prefix}${handoffReasonLabel(reason)}（${evidence}）。${d.userAction}`, { reason, userAction: d.userAction, captchaKind: d.kind, ...extra })
  }
  const blockerHandoff = (u: { text: string; buttons: string[]; reason: string }) => finish('handoff', `页面弹出了一个对话框，我没把握该点哪个：「${u.text.slice(0, 80)}」（${u.reason}）`, {
    reason: 'user_request', userAction: `页面上有个弹窗「${u.text.slice(0, 60)}」（按钮：${u.buttons.slice(0, 4).join(' / ') || '无'}），请你在浏览器里处理掉它，然后点"交还"，我接着填`,
  })
  /** 一路下来没碰到任何表单项。 */
  const untouched = () => !all.filled.length && !all.needsUser.length && !all.drafts.length && !all.uploads.length && !all.mismatches.length
  const entryHandoff = (button: string) => finish('handoff', `这是岗位详情页，不是网申表：页面上没有可填写的字段，「${button}」是申请入口。`, {
    reason: 'login', userAction: `请在浏览器里点「${button}」进入网申（通常要先登录），看到申请表后点"交还"，我从那一页接着填`,
  })
  let lastFingerprint = ''

  try {
    try { libraries = await page.evaluate(libraryFingerprintScript) } catch { /* ignore */ }
    recorder.trace({ stage: 'start', result: 'info', detail: `${page.url()} | 组件库：${libraries.join(',') || '未识别'} | 适配器：${adapter.id}` })
    if (adapter.preprocess) await adapter.preprocess(page).catch(e => log(`预处理失败：${e instanceof Error ? e.message : e}`))
    for (let index = 1; index <= maxPages; index++) {
      // 0. 风险锁 / 页数上限
      if (opts.riskGuard) {
        const s = opts.riskGuard.shouldStop()
        if (s.stop) return finish('blocked', `风险守卫要求停止：${s.reason}${s.detail ? '（' + s.detail + '）' : ''}`)
        if (!opts.riskGuard.reservePage()) return finish('blocked', '今日页数上限已到')
      }
      // 1. 阻碍检测
      let sig = await step('读取页面信号', () => page.evaluate(pageSignalsScript))
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
      const rec: PageRecord = { index, url: page.url(), fieldCount: 0, filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], errors: [], escalations: [] }
      // 1.5 障碍层：页面一打开就挡着的弹窗（cookie / 须知 / 公告）
      if (!(await blockers('page', rec)) && unresolvedBlocker) { pages.push(rec); return blockerHandoff(unresolvedBlocker) }

      // 2. 抽取（L1）；抽不到且有感知器 → L2 视觉伪字段
      let fields = await step('抽取字段', () => extractFields(page))
      let layer: DriveLayer = 'dom'
      rec.fieldCount = fields.length
      // 2.1 岗位详情页：页面上没有任何表单字段、这次也没填过东西 → 允许点申请入口按钮进入网申表（最终提交仍永不点）
      if (!fields.length && untouched() && opts.allowEntryClick !== false && entryClicks < 2) {
        const entry = sig.buttons.find(b => !b.disabled && isEntryText(b.text))
        if (entry) {
          entryClicks++
          progress(`点击「${entry.text}」进入申请表`, 'entry', entry.text)
          recorder.trace({ stage: 'entry', action: 'click', result: 'info', detail: entry.text })
          await page.evaluate(prepareEntryClickScript, { selector: entry.selector }).catch(() => null)
          try {
            await clickEntry(page, entry, adapter)
            entryClicked = entry.text
            await page.waitForTimeout(Math.max(opts.settleMs ?? 800, 0) * 2)
            await humanDelay(pause[0], pause[1], opts)
            index--
            continue
          } catch (e) {
            const c = classifyError(e)
            recorder.trace({ stage: 'entry', action: 'click', result: 'fail', code: c.code, detail: c.raw })
          }
        }
      }
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
        if (index === 1 || untouched()) {
          pages.push(rec); all.escalations.push(...rec.escalations)
          const entry = sig.buttons.find(b => isEntryText(b.text)) ?? findFinalSubmit(sig.buttons, adapter)
          return entry ? entryHandoff(entry.text) : finish('blocked', '页面上没有可填写的表单字段')
        }
        break // 后续页没字段：可能到了确认页
      }
      rec.layer = layer
      layersUsed.add(layer)
      sensitive = fields.filter(f => isSensitiveLabel(f.label) && f.layer !== 'vision').map(f => f.selector)
      // 组件库指纹按页累积（详情页和表单页往往不一样）
      try { libraries = [...new Set([...libraries, ...(await page.evaluate(libraryFingerprintScript)), ...fields.map(f => f.framework).filter((x): x is string => !!x && x !== 'native')])] } catch { /* ignore */ }
      progress(`第 ${index} 页：找到 ${fields.length} 个要看的格子`, 'page')
      log(`第 ${index} 页：${fields.length} 个字段（${layer}）`)
      recorder.trace({ stage: 'page', result: 'info', detail: `第 ${index} 页 ${page.url()}：${fields.map(f => `${f.id}:${f.label}${f.required ? '*' : ''}${f.labelUncertain ? '?' : ''}`).join(' | ')}` })
      await capture(`page${index}`)
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
      // 宁空不错：标签可疑（吸顶栏文字 / 纯数字 / 没标签）的字段不按它填
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (f?.labelUncertain && p.status === 'fill' && !f.isFile) {
          recorder.trace({ stage: 'plan', field: f.id, label: f.label, result: 'skip', code: 'label_uncertain', detail: f.labelUncertain })
          Object.assign(p, { status: 'needs_user', value: undefined, code: 'label_uncertain', note: `${reasonText('label_uncertain')}（${f.labelUncertain}）` })
        }
      }
      /** 本页已写过（或尝试写过）的字段：分区填写、复核都不再写不同来源的值。 */
      const written = new Map<string, { value: string; stage: string }>()
      const record = (f: FormField, value: string, source: FieldPlan['source'], att: FieldAttempt, stage: string) => {
        written.set(f.id, { value, stage })
        if (att.verified) rec.filled.push({ fieldId: f.id, label: f.label, value, source, layer: att.strategy === 'vision' ? 'vision' : 'dom', verified: true, strategy: att.strategy, display: att.display })
        else if (att.rollback === 'failed') rec.mismatches.push({ fieldId: f.id, label: f.label, expected: value, actual: att.display, code: att.code ?? 'readback_mismatch', reason: att.reason ?? reasonText(att.code) })
        else rec.needsUser.push({ fieldId: f.id, label: f.label, status: 'needs_user', source, confidence: 0, note: att.reason ?? reasonText(att.code), code: att.code ?? 'readback_mismatch' })
      }

      // 4. 先上传简历（上传后页面可能弹"是否解析附件"、自动填充，过一遍障碍层再重新抽取）
      let uploaded = false
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (!f || !f.isFile || p.status !== 'fill' || !p.value) continue
        try {
          progress(`上传简历「${basename(p.value)}」`, 'upload', f.label)
          await page.setInputFiles(f.selector, p.value)
          await humanDelay(pause[0] * 2, pause[1] * 2, opts)
          if (!(await blockers('after_upload', rec)) && unresolvedBlocker) { pushPage(); return blockerHandoff(unresolvedBlocker) }
          const check = await checkUploadEcho(page, f, p.value)
          rec.uploads.push(check)
          rec.filled.push({ fieldId: f.id, label: f.label, value: basename(p.value), source: p.source, layer: 'dom', verified: check.echoed, strategy: 'upload' })
          written.set(f.id, { value: p.value, stage: 'upload' })
          uploaded = true
          recorder.trace({ stage: 'upload', field: f.id, label: f.label, result: check.echoed ? 'ok' : 'fail', detail: check.evidence })
          log(`上传 ${basename(p.value)}：${check.echoed ? '页面已回显' : '未看到回显'}`)
        } catch (e) {
          const c = classifyError(e)
          recorder.trace({ stage: 'upload', field: f.id, label: f.label, result: 'fail', code: c.code, detail: c.raw })
          rec.uploads.push({ fieldId: f.id, file: basename(p.value), echoed: false, evidence: `上传失败：${c.text}` })
        }
      }
      if (uploaded) { fields = await step('抽取字段', () => extractFields(page)); for (const f of fields) byId.set(f.id, f) }

      // 5. 逐字段：填写 + 核验 + 失败回滚（只填与当前值不同的；高影响缺答案 / 草稿不填）
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (!f) continue
        if (p.status === 'needs_user') { rec.needsUser.push(p); continue }
        if (p.status === 'draft_needs_confirm') { rec.drafts.push(p); continue }
        if (f.isFile || p.status !== 'fill' || p.value === undefined) continue
        if (f.layer === 'vision') {
          const r = await visionFill(page, visionOpts!, f.label, p.value)
          // 视觉伪字段读不回 DOM：写进去了也标"未核验"，审阅时要人看
          if (r.ok) rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source, layer: 'vision', verified: false, strategy: 'vision' })
          else rec.needsUser.push({ fieldId: f.id, label: f.label, status: 'needs_user', source: p.source, confidence: 0, note: `${reasonText('vision_failed')}（${r.evidence}）`, code: 'vision_failed' })
          recorder.trace({ stage: 'field', field: f.id, label: f.label, strategy: 'vision', result: r.ok ? 'ok' : 'fail', code: r.ok ? undefined : 'vision_failed', detail: r.evidence })
          await humanDelay(pause[0], pause[1], opts)
          continue
        }
        if (sameValue(f, p.value)) {
          const display = await readDisplay(page, f)
          if (displayMatches(display || f.value, p.value, f)) {
            written.set(f.id, { value: p.value, stage: 'prefilled' })
            rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source, layer: 'dom', verified: true, strategy: 'already', display: display || f.value })
            continue
          }
        }
        let att = await fillAndVerify(fillDeps, f, p.value, 'field')
        // L2：普通文本框 DOM 填不进（完全自绘 / 吞输入）→ 视觉层坐标键入，再用 DOM 读回核验
        if (!att.verified && visionOpts && TEXTLIKE.has(f.type) && f.framework !== 'mtd' && ['readback_mismatch'].includes(att.code ?? '')) {
          const r = await visionFill(page, visionOpts, f.label, p.value)
          layersUsed.add('vision')
          const display = await readDisplay(page, f)
          const ok = r.ok && displayMatches(display, p.value, f)
          rec.escalations.push({ reason: 'fill_mismatch', field: f.label, outcome: ok ? 'recovered' : 'failed', evidence: r.evidence })
          if (ok) att = { verified: true, strategy: 'vision', display }
          else if (r.ok) att = { ...att, rollback: await rollbackText(page, f) }
        } else if (att.verified && att.strategy === 'native-setter') {
          rec.escalations.push({ reason: 'fill_mismatch', field: f.label, outcome: 'recovered', evidence: '页内执行器重填' })
        }
        record(f, p.value, p.source, att, 'field')
        await humanDelay(pause[0], pause[1], opts)
      }

      // 5.5 重复分区（教育 / 实习工作 / 项目经历的"表格"）：逐行填，不够就点"添加一行"再填新出现的那一行（只在 DOM 层）
      if (layer === 'dom') {
        try {
          if (!(await blockers('section', rec)) && unresolvedBlocker) { pushPage(); return blockerHandoff(unresolvedBlocker) }
          // 重新抽取：拿到第 5 步填完后的当前值，已有值的行不覆盖
          fields = await step('抽取字段', () => extractFields(page)); for (const f of fields) byId.set(f.id, f)
          const planned = new Set(plans.filter(p => p.status !== 'skip').map(p => p.fieldId))
          const sec = await fillRepeatingSections(page, fields, profile, {
            fill: async (f, v) => {
              const att = await fillAndVerify(fillDeps, f, v, 'section')
              record(f, v, 'profile', att, 'section')
              return att.verified
            },
            // 同一字段只写一次：字段阶段已写过 / 计划过的不再由分区写入
            skip: f => written.has(f.id) || planned.has(f.id) || !!f.labelUncertain,
            settleMs: opts.settleMs, log, isSubmit: t => isSubmitText(t, adapter), resolveValue: opts.resolveValue,
            beforeSection: async () => { await blockers('section', rec) },
          })
          if (sec.sections.length) rec.sections = sec.sections
          if (sec.fields !== fields) { fields = sec.fields; for (const f of fields) byId.set(f.id, f) }
          for (const s of sec.sections) {
            if (s.note) log(`分区「${s.key}」：${s.note}`)
            if (s.filled || s.added) progress(`${s.key === 'education' ? '教育经历' : s.key === 'experience' ? '实习/工作经历' : '项目经历'}：填了 ${s.filled} 格${s.added ? `，新增 ${s.added} 行` : ''}`, 'section')
          }
        } catch (e) { log(`重复分区填写异常：${e instanceof Error ? e.message : String(e)}`); recorder.bump('section_error') }
      }

      // 6. 整页复核（只对 DOM 层）：核验通过的值有没有被页面后来的动作冲掉（如上传解析回填、联动清空）；冲掉的重填一次，再不行就清空留给用户
      if (layer === 'dom') {
        const after = await step('抽取字段', () => extractFields(page))
        const verifiedNow = rec.filled.filter(r => r.verified && r.strategy !== 'upload' && !byId.get(r.fieldId)?.isFile)
        for (const d of diffAgainstPlan(after, verifiedNow)) {
          const f = after.find(x => x.id === d.fieldId)
          const display = f ? await readDisplay(page, f) : ''
          if (f && displayMatches(display, d.expected, f)) continue
          const idx = rec.filled.findIndex(r => r.fieldId === d.fieldId)
          const old = rec.filled[idx]
          rec.filled.splice(idx, 1)
          recorder.trace({ stage: 'recheck', field: d.fieldId, label: d.label, result: 'fail', code: 'readback_mismatch', detail: `复核时显示「${display}」` })
          if (!f) { rec.needsUser.push({ fieldId: d.fieldId, label: d.label, status: 'needs_user', source: old.source, confidence: 0, note: reasonText('element_missing'), code: 'element_missing' }); continue }
          const att = await fillAndVerify(fillDeps, f, d.expected, 'recheck')
          record(f, d.expected, old.source, att, 'recheck')
        }
        // 站点记忆：读回核对通过的 profile 字段，记下"这站这个字段 ↔ 资料键"，下次别名匹配不到也能直填
        if (opts.siteMemory) {
          const good = new Set(rec.filled.filter(r => r.verified).map(r => r.fieldId))
          for (const p of plans) {
            const f = byId.get(p.fieldId)
            if (!f || !p.key || p.status !== 'fill' || !good.has(p.fieldId)) continue
            opts.siteMemory.remember(host, { name: f.name, xpath: f.xpath, label: f.label }, p.key, p.note === '按站点记忆匹配' ? 'learned' : 'alias')
            all.memorized++
          }
        }
        rec.fields = outcomesFor(index, after.length ? after : fields, rec)
      } else rec.fields = outcomesFor(index, fields, rec)
      sig = await step('读取页面信号', () => page.evaluate(pageSignalsScript))
      rec.errors = sig.errors
      // 填写过程中可能触发验证码
      const ob2 = detectObstacle(sig, adapter)
      if (ob2) { pushPage(); opts.riskGuard?.inspect(sig, adapter); return handoff(ob2.reason, sig, ob2.evidence, '填写过程中出现需要你本人处理的情况：') }

      // 7. 找按钮：提交一律不点；有"下一步"就点；DOM 找不到 → 视觉层找文案
      const submit = findFinalSubmit(sig.buttons, adapter)
      const next = sig.buttons.find(b => !b.disabled && isNextText(b.text, adapter))
      if (!next && !submit && visionOpts) {
        const submitWords = [...(adapter.hints.submitWords ?? []), ...SUBMIT_WORDS]
        const vSubmit = await visionFindButton(page, visionOpts, submitWords)
        if (vSubmit) {
          rec.escalations.push({ reason: 'no_next_button', outcome: 'stopped', evidence: `DOM 没有按钮，截图里看到提交类按钮「${vSubmit.text}」` })
          layersUsed.add('vision'); pushPage()
          if (untouched()) return entryHandoff(vSubmit.text)
          return finish('stopped_before_submit', `已填完，停在「${vSubmit.text}」前（视觉层识别），等你确认后再提交`, { submitButton: vSubmit.text, reason: 'submit_confirm' })
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
        rec.escalations.push({ reason: 'no_next_button', outcome: 'failed', evidence: vNext.evidence })
      }
      if (!next) {
        pushPage()
        if (untouched()) return submit ? entryHandoff(submit.text) : finish('blocked', '页面上没有找到可填写的网申表单，也没有下一步或提交按钮')
        const msg = submit ? `已填完，停在「${submit.text}」前，等你确认后再提交` : '表单已填完，页面上没有找到下一步或提交按钮，请人工检查'
        return finish('stopped_before_submit', msg, { submitButton: submit?.text, reason: submit ? 'submit_confirm' : undefined })
      }
      rec.nextButton = next.text
      pushPage()
      progress(`点击「${next.text}」`, 'page')
      try { await clickButton(page, next, adapter) } catch (e) {
        // 被弹窗挡住 / 超时：过一遍障碍层再点一次；提交类文案的拒绝不重试
        const c = classifyError(e)
        if (c.code !== 'blocked_by_overlay' && c.code !== 'timeout') throw e
        recorder.trace({ stage: 'next', action: 'click', result: 'fail', code: c.code, detail: c.raw })
        if (!(await blockers('next', rec)) && unresolvedBlocker) return blockerHandoff(unresolvedBlocker)
        await clickButton(page, next, adapter)
      }
      await page.waitForTimeout(opts.settleMs ?? 800)
      await humanDelay(pause[0], pause[1], opts)

      function pushPage() {
        rec.fields ??= outcomesFor(index, fields, rec)
        pages.push(rec); all.filled.push(...rec.filled); all.needsUser.push(...rec.needsUser); all.drafts.push(...rec.drafts); all.mismatches.push(...rec.mismatches); all.uploads.push(...rec.uploads); all.escalations.push(...rec.escalations); allFields.push(...rec.fields); opts.onPage?.(rec)
      }
    }
    // 走完页数上限还没见到提交按钮
    const sig = await page.evaluate(pageSignalsScript)
    const submit = findFinalSubmit(sig.buttons, adapter)
    if (submit && untouched()) return entryHandoff(submit.text)
    if (submit) return finish('stopped_before_submit', `已填完，停在「${submit.text}」前，等你确认后再提交`, { submitButton: submit.text, reason: 'submit_confirm' })
    return finish('blocked', `已走完 ${maxPages} 页仍未到提交页，停止以免失控`)
  } catch (e) {
    const c = classifyError(e)
    recorder.trace({ stage: 'crash', result: 'fail', code: c.code, detail: c.raw })
    const screenshot = await page.screenshot().catch(() => undefined)
    const result: DriveResult = { status: 'failed', message: `网申填写中断：${c.text}`, failureCode: c.code, pages, ...all, layersUsed: [...layersUsed], fields: allFields, blockers: allBlockers, entryClicked, libraries, ...(telemetryRef ? { telemetry: telemetryRef } : {}), screenshot, finalUrl: page.url(), adapterId: adapter.id }
    summarize('failed', result)
    return result
  }
}

async function readDisplay(page: PageLike, f: FormField): Promise<string> {
  if (f.layer === 'vision') return ''
  try { return (await page.evaluate(readDisplayScript, { selector: f.selector })).display } catch { return f.value ?? '' }
}
async function rollbackText(page: PageLike, f: FormField): Promise<'restored' | 'failed'> {
  try { await page.fill(f.selector, f.value ?? ''); return normKey(await readDisplay(page, f)) === normKey(f.value ?? '') ? 'restored' : 'failed' } catch { return 'failed' }
}

/** 本页每个字段的最终状态。 */
function outcomesFor(index: number, fields: FormField[], rec: PageRecord): FieldOutcome[] {
  const out: FieldOutcome[] = []
  for (const f of fields) {
    const base = { fieldId: f.id, label: f.label, page: index, type: f.type, required: f.required, ...(f.requiredVia ? { requiredVia: f.requiredVia } : {}), ...(f.labelUncertain ? { labelUncertain: f.labelUncertain } : {}) }
    const filled = rec.filled.find(r => r.fieldId === f.id)
    const mm = rec.mismatches.find(r => r.fieldId === f.id)
    const nu = rec.needsUser.find(r => r.fieldId === f.id)
    const dr = rec.drafts.find(r => r.fieldId === f.id)
    if (mm) out.push({ ...base, status: 'mismatch', verified: false, value: mm.expected, display: mm.actual, code: mm.code, reason: mm.reason })
    else if (filled) out.push({ ...base, status: filled.verified ? 'verified' : 'unverified', verified: !!filled.verified, value: filled.value, display: filled.display, strategy: filled.strategy, source: filled.source })
    else if (nu) out.push({ ...base, status: 'needs_user', verified: false, code: nu.code, reason: nu.note, source: nu.source })
    else if (dr) out.push({ ...base, status: 'draft', verified: false, value: dr.value, source: 'draft' })
    else {
      const empty = f.type === 'checkbox' ? f.value !== 'true' : !(f.value ?? '').trim()
      if (!empty) out.push({ ...base, status: 'prefilled', verified: false, display: f.value })
      else if (f.required) out.push({ ...base, status: 'needs_user', verified: false, reason: '必填项还是空的' })
      else out.push({ ...base, status: 'empty_optional', verified: false })
    }
  }
  return out
}

/** 点击前最后一道防线：文案像提交就拒绝。 */
async function clickButton(page: PageLike, b: ButtonInfo, adapter: SiteAdapter): Promise<void> {
  if (isSubmitText(b.text, adapter)) throw new Error(`拒绝点击提交类按钮「${b.text}」`)
  await page.click(b.selector)
}
/** 申请入口：只认入口文案（立即申请 / 申请职位 / 我要投递 / Apply…），且调用方已确认页面上没有表单字段。 */
async function clickEntry(page: PageLike, b: ButtonInfo, adapter: SiteAdapter): Promise<void> {
  if (!isEntryText(b.text)) throw new Error(`「${b.text}」不是申请入口按钮`)
  if ((adapter.hints.submitWords ?? []).some(w => normKey(w) === normKey(b.text)) && !/申请|apply/i.test(b.text)) throw new Error(`「${b.text}」是该站的提交按钮`)
  await page.click(b.selector)
}

function sameValue(f: FormField, v: string): boolean {
  if (f.value === undefined || f.value === '') return false
  if (f.type === 'checkbox') return (f.value === 'true') === /^(true|1|yes|是)$/i.test(v)
  if (normKey(f.value) === normKey(v)) return true
  // 下拉：页面显示的是选项文案（"硕士研究生"），计划值可能是资料写法（"硕士"）→ 字典 / 包含匹配算一致
  if (f.type === 'select') return !!matchOption([f.value], v, { label: f.label })
  return displayMatches(f.value, v, f)
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
