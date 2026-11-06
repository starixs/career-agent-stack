import { handoffReasonLabel, type LLM, type HandoffReason } from '@career/core'
import { basename, extname } from 'node:path'
import type { PageLike } from './page.js'
import { extractFields, formFingerprint, type FormField } from './extract.js'
import { chooseFromEvidence, interpretForm, normKey, type FieldPlan, type Profile, type InterpretOptions } from './interpret.js'
import { pageSignalsScript, type PageSignals, type ButtonInfo } from './scripts.js'
import { detectObstacle, findFinalSubmit, isDetailEntryText, isEntryText, isNextText, isSubmitText, loginMethodsOf, type LoginMethod, type Obstacle } from './guards.js'
import { navigateToPosition, positionLinksScript, type PositionLink, type PositionTarget } from './navigate.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'
import type { RiskGuard } from './safety.js'
import { humanDelay, type PacingOptions } from './pacing.js'
import { fillLoginForm, type LoginCredential } from './login.js'
import { verifyBeforeContinuing, type VerificationHandler } from './verification.js'
import { looksLikeFormVisually, pairVisualFields, type Perceiver, type UiKind } from './perception.js'
import { visionScan, visionFill, visionClickText, visionFindButton, type VisionOptions } from './vision.js'
import { describeObstacle, looksLikeRiskUrl, type CaptchaKind } from './obstacles.js'
import { fillRepeatingSections, matchRowField, rangeFieldIds, SECTIONS, type SectionSummary } from './sections.js'
import { resolveRangeValues } from './range-fallback.js'
import { normalizeHost, type SiteMemory, type WidgetMemory } from './memory.js'
import { matchOption } from './normalize.js'
import type { FieldType } from './scripts.js'
import { buildSubmitReview, type SubmitReview } from './review.js'
import { clearBlockers, type HandledBlocker } from './blockers.js'
import { displayMatches, fillAndVerify, type FieldAttempt } from './fill.js'
import { classifyError, reasonText, withWatchdog, type FieldReasonCode } from './codes.js'
import { isSensitiveLabel, noopRecorder, RunRecorder, type Recorder, type TelemetryOptions } from './telemetry.js'
import { snapshotNeedsUser } from './diag.js'
import { attachOptions, explainWaiting, settleNeedsUser } from './needs.js'
import { clearHighlightScript, libraryFingerprintScript, maskSensitiveScript, prepareEntryClickScript, readDisplayScript, uploadAreaScript, type UploadAreaResult } from './widgets.js'

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
/** 网址本身就是某一个岗位：/position/123/detail、/job/abc123、#/job/uuid、/jobs/12345。 */
export const POSITION_URL_RX = /(\/position\/\d{5,}|\/(job|jobs|post|position)[/-]?(detail|info)?\/[\w-]{6,}|[?&](post_?id|job_?id|positionId|jobUnionId)=)/i

/**
 * 组件库指纹只收字符串数组。真实 Chrome 桥接在个别页面上把脚本结果回成字符串 "undefined"，
 * 直接展开会变成 u,n,d,e,f,i 记进埋点（2026-11-05 jdjianli.com）。
 */
export function libraryList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

export interface DriveResult {
  status: DriveStatus
  /** handoff 时的原因；blocked 时可能是 missing_info。 */
  reason?: HandoffReason
  /** 停在一个拿不准的弹窗上：它问的话和按钮，等你卡上让学生直接选（选完存进站点记忆，续跑时引擎替他点）。 */
  dialog?: { text: string; buttons: string[] }
  message: string
  /** handoff 时：用户具体该做什么（给接管条展示）。 */
  userAction?: string
  /** 登录接管时页面上给了哪几种登法（guards.loginMethodsOf）。 */
  loginMethods?: LoginMethod[]
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
  /** 没找到网申表时页面的正文（≤ PAGE_TEXT_MAX 字）：调用方据此判断岗位是不是已经结束招聘。 */
  pageText?: string
  screenshot?: Uint8Array
  finalUrl: string
  adapterId: string
  /** stopped_before_submit 时的填后检查（审阅清单 + 免审指纹）。 */
  review?: SubmitReview
}

/** 给界面的人话进度（不含内部调试信息、不含明文敏感值）。 */
export interface DriveProgress {
  message: string
  kind: 'page' | 'field' | 'blocker' | 'upload' | 'entry' | 'section' | 'stop' | 'jd'
  label?: string
  /** kind='jd'：岗位详情页的正文（≤ JD_TEXT_MAX 字），每次运行至多一次；调用方拿去存岗位描述，不要原样展示。 */
  text?: string
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
  /** 宿主自动验证：在资料进模型之前运行，失败保留人工接管；最终提交不走这里。 */
  verify?: VerificationHandler
  /** 视觉兜底层的感知器（OCR / 视觉模型）。不给则只有 DOM 层。 */
  perceiver?: Perceiver
  vision?: { maxFieldsPerPage?: number; maxScrolls?: number }
  /** 站点映射记忆：别名匹配不到的字段按上次记录直填；读回核对通过的 profile 字段记下来。 */
  siteMemory?: SiteMemory
  /** 站点控件记忆；不传时用 siteMemory 同一存储上的控件记忆。 */
  widgetMemory?: WidgetMemory
  /** 关掉模型接手（field-agent.ts：结构树没办成时交模型接着办）。 */
  semanticFallback?: boolean
  /** 续跑时：这些标签上次是 needs_user，若现在页面上已有值（用户自己填的），回传给调用方存进答案库。 */
  learnFrom?: string[]
  /**
   * 接管交回后从当前页续跑：这一页之前已经填过、他也动过。没有格子、只有提交类按钮的是确认页（他点了「预览并提交」到了「确认提交」），
   * 不是岗位详情页的申请入口——停在提交前等他确认，不报「这是岗位详情页」（2026-11-05 滴滴）。
   */
  resumed?: boolean
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
  /** 打开的是校招首页 / 合集页时去找哪种岗位（navigate.ts）；不给就不找，按原样报「没有表单」。 */
  target?: PositionTarget
  /**
   * 内置找路（navigate.ts 的规则）走不通时，交给模型自主找路（GA 式循环，由调用方注入，face-ga-port 已定）。
   * moved=true：页面已经到了网申表或登录页，引擎接着按原流程判断；note：没找到时给学生看的一句话（原样作为结果说明）。
   */
  pathfinder?: (why: string) => Promise<{ moved: boolean; note?: string }>
  /** 障碍层 / 下拉候选不确定时用的模型（缺省用 driveApplication 的 llm）。 */
  widgetLlm?: LLM | null
}

const SUBMIT_WORDS = ['提交', '确认提交', '提交申请', '投递', '立即投递', 'Submit', 'Apply now'] as const
const NEXT_WORDS = ['下一步', '下一页', '继续', '保存并继续', '保存并下一步', 'Next', 'Continue'] as const
const KIND_TO_TYPE: Partial<Record<UiKind, FieldType>> = { input: 'text', select: 'select', checkbox: 'checkbox', radio: 'radio' }
const PAGE_STEP_MS = 25_000
/** 从首页走到岗位详情最多跳几次：首页 → 列表 → 详情，再多就是在乱逛。 */
const MAX_NAV_HOPS = 2
const TEXTLIKE = new Set<FieldType>(['text', 'email', 'tel', 'number', 'textarea'])
/** 详情页正文最多交出去多少字：一份 JD 通常两三千字，8k 足够，又不会把整页导航、页脚都带上。 */
export const JD_TEXT_MAX = 8000
/** 没找到表单时带回的页面正文：只用来认「已结束 / 已截止」这类字样，2k 足够。 */
export const PAGE_TEXT_MAX = 2000

const isRecorder = (t: DriveOptions['telemetry']): t is Recorder => !!t && typeof (t as Recorder).trace === 'function'

export async function driveApplication(page: PageLike, llm: LLM, profile: Profile, opts: DriveOptions = {}): Promise<DriveResult> {
  const maxPages = opts.maxPages ?? 6
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const pause = opts.pause ?? [300, 900]
  const host = normalizeHost(page.url())
  const recorder: Recorder = isRecorder(opts.telemetry) ? opts.telemetry : opts.telemetry ? new RunRecorder(opts.telemetry, host) : noopRecorder
  const log = (msg: string) => { opts.log?.(msg); recorder.trace({ stage: 'log', result: 'info', detail: msg }) }
  const progress = (message: string, kind: DriveProgress['kind'] = 'field', label?: string) => { opts.onProgress?.({ message, kind, label }); recorder.trace({ stage: 'progress', result: 'info', detail: message }) }
  let jdSent = false
  /** 落到岗位详情页（要点申请入口之前）时把正文交给调用方一次：存成岗位描述，供下一次按岗位定制简历。尽力而为，出错只记日志。 */
  const captureJd = (text: string) => {
    if (jdSent || !opts.onProgress || !text.trim()) return
    jdSent = true
    try { opts.onProgress({ message: '读到岗位介绍', kind: 'jd', text: text.slice(0, JD_TEXT_MAX) }) } catch (e) { log(`岗位介绍回传失败：${e instanceof Error ? e.message : String(e)}`) }
  }
  const widgetLlm = opts.widgetLlm === null ? undefined : opts.widgetLlm ?? llm
  const pages: PageRecord[] = []
  const all = { filled: [] as FilledRecord[], needsUser: [] as FieldPlan[], drafts: [] as FieldPlan[], mismatches: [] as Mismatch[], uploads: [] as UploadCheck[], escalations: [] as Escalation[], learned: [] as Array<{ label: string; value: string }>, memorized: 0 }
  const allFields: FieldOutcome[] = []
  const allBlockers: HandledBlocker[] = []
  let libraries: string[] = []
  let entryClicked: string | undefined
  let entryClicks = 0
  let navHops = 0
  let lastSeekTried: string[] = []
  let lastSeekNote: string | undefined
  let pathfinderUsed = false
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
    const r = await clearBlockers(page, { llm: widgetLlm, recorder, progress: m => progress(m, 'blocker'), log, settleMs: Math.min(opts.settleMs ?? 400, 600) || 0, stage, ...(opts.siteMemory ? { presetChoice: (text: string) => opts.siteMemory?.dialogChoice(host, text) } : {}) })
    if (r.handled.length) { allBlockers.push(...r.handled); if (rec) (rec.blockers ??= []).push(...r.handled) }
    unresolvedBlocker = r.unresolved
    return !r.unresolved
  }
  const widgetEvents = { used: new Set<string>(), learned: new Set<string>() }
  const widgetStore = opts.widgetMemory ?? opts.siteMemory?.widgets()
  const widgetMemory = widgetStore?.bind(host, e => { (e.kind === 'used' ? widgetEvents.used : widgetEvents.learned).add(`${e.sig} → ${e.detail}`); if (e.kind === 'learned') log(`控件记忆：${e.sig} → ${e.detail}`) })
  const snapshot = async () => {
    if (sensitive.length) await page.evaluate(maskSensitiveScript, { on: true, selectors: sensitive }).catch(() => {})
    try { return await (page.screenshotSmall ? page.screenshotSmall() : page.screenshot()) } finally { if (sensitive.length) await page.evaluate(maskSensitiveScript, { on: false }).catch(() => {}) }
  }
  const fillDeps = { widgetMemory, snapshot, semantic: opts.semanticFallback, page, pause, humanTyping: opts.humanTyping, llm: widgetLlm, recorder, progress: (m: string) => progress(m, 'field'), log, watchdogMs: opts.watchdogMs ?? 30_000, clearBlockers: () => blockers('field'), capture, highlight: opts.highlight, rng: opts.rng, sleep: opts.sleep }

  const summarize = (status: string, extra: Partial<DriveResult>) => {
    const fs = allFields
    recorder.finish({
      status, libraries, pages: pages.length, entryClicked, layersUsed: [...layersUsed],
      fields: { total: fs.length, verified: fs.filter(f => f.verified).length, needsUser: fs.filter(f => f.status === 'needs_user').length, mismatch: fs.filter(f => f.status === 'mismatch').length, emptyOptional: fs.filter(f => f.status === 'empty_optional').length, labelUncertain: fs.filter(f => f.labelUncertain).length },
      blockers: allBlockers.map(b => ({ text: b.text.slice(0, 120), choice: b.choice, by: b.by, resolved: b.resolved })),
      requiredTrusted: extra.review?.requiredTrusted,
      ...(widgetEvents.used.size || widgetEvents.learned.size ? { widgetMemory: { used: [...widgetEvents.used].slice(0, 20), learned: [...widgetEvents.learned].slice(0, 20) } } : {}),
    })
  }
  const telemetryRef = recorder.dir && recorder.runId ? { dir: recorder.dir, runId: recorder.runId } : undefined
  const finish = async (status: DriveStatus, message: string, extra: Partial<DriveResult> = {}): Promise<DriveResult> => {
    // 一格都没填、停在的「提交」其实是详情页的申请入口（投递简历 / 立即投递 / 申请职位）：这不是填好的网申表，
    // 绝不报「已填完，停在提交前」——他一批准就会按下可能是一键投递的按钮（2026-11-02 小红书：岗位描述被视觉层当成格子）
    if (status === 'stopped_before_submit' && !all.filled.length && extra.submitButton && isDetailEntryText(extra.submitButton, adapter)) {
      return entryHandoff(extra.submitButton)
    }
    all.needsUser = await attachOptions(page, explainWaiting(settleNeedsUser(all.needsUser, all.filled)), log)
    let screenshot: Uint8Array | undefined
    try { await page.evaluate(clearHighlightScript) } catch { /* ignore */ }
    try { screenshot = await page.screenshot() } catch { /* 截图失败不影响结果 */ }
    // 停在提交前：做一遍填后检查，给审核卡片的审阅清单与免审判断
    let review: SubmitReview | undefined
    if (status === 'stopped_before_submit') {
      try { review = await buildSubmitReview(page, all) } catch (e) { log(`填后检查失败，按需要人看处理：${e instanceof Error ? e.message : String(e)}`) }
      // 「已填完」只在填后检查真没缺项时说；还有必填空着 / 网站报错就如实报缺什么（2026-11-05 滴滴：大半必填没填却报已填完）
      if (review) message = stopMessage(message, review, extra.submitButton)
      progress(message, 'stop')
    }
    const result: DriveResult = { status, message, pages, ...all, layersUsed: [...layersUsed], fields: allFields, blockers: allBlockers, entryClicked, libraries, ...(telemetryRef ? { telemetry: telemetryRef } : {}), screenshot, finalUrl: page.url(), adapterId: adapter.id, ...(review ? { review } : {}), ...extra }
    if (all.needsUser.length) await snapshotNeedsUser(page, recorder, all.needsUser)
    recorder.trace({ stage: 'finish', result: status === 'failed' ? 'fail' : 'info', detail: `${status}：${message}` })
    summarize(status, result)
    return result
  }
  const handoff = (reason: HandoffReason, sig: PageSignals, evidence: string, prefix: string, extra: Partial<DriveResult> = {}) => {
    const d = describeObstacle(reason, sig, evidence, { loginFilled: extra.loginFilled })
    return finish('handoff', `${prefix}${handoffReasonLabel(reason)}（${evidence}）。${d.userAction}`, { reason, userAction: d.userAction, captchaKind: d.kind, ...(reason === 'login' ? { loginMethods: loginMethodsOf(sig) } : {}), ...extra })
  }
  const blockerHandoff = (u: { text: string; buttons: string[]; reason: string }) => finish('handoff', `页面弹出了一个对话框，我没把握该点哪个：「${u.text.slice(0, 80)}」（${u.reason}）`, {
    reason: 'user_request', userAction: `页面上有个弹窗「${u.text.slice(0, 60)}」（按钮：${u.buttons.slice(0, 4).join(' / ') || '无'}），请你在浏览器里处理掉它，然后点"交还"，我接着填`,
    ...(u.buttons.length ? { dialog: { text: u.text, buttons: u.buttons } } : {}),
  })
  /** 一路下来没碰到任何表单项。 */
  const untouched = () => !all.filled.length && !all.needsUser.length && !all.drafts.length && !all.uploads.length && !all.mismatches.length
  /** 什么都没填成，只有截图识字层点不进去的「格子」。 */
  const visionOnlyMisses = () => !all.filled.length && !all.uploads.length && !all.drafts.length && !all.mismatches.length && all.needsUser.length > 0 && all.needsUser.every(p => p.code === 'vision_failed')
  const entryHandoff = (button: string) => finish('handoff', `这是岗位详情页，不是网申表：页面上没有可填写的字段，「${button}」是申请入口。`, {
    reason: 'login', userAction: `请在浏览器里点「${button}」进入网申（通常要先登录），看到申请表后点"交还"，我从那一页接着填`,
  })
  let lastFingerprint = ''
  /** 去站里找对口岗位（navigate.ts）；找到了返回 true，调用方重读这一页。 */
  const seek = async (why: string): Promise<boolean> => {
    if (!opts.target || opts.resumed || !untouched() || navHops >= MAX_NAV_HOPS) return false
    navHops++
    const nav = await navigateToPosition(page, adapter, opts.target, { settleMs: Math.max(opts.settleMs ?? 800, 0) * 2, log })
    recorder.trace({ stage: 'entry', action: 'navigate', result: nav.moved ? 'info' : 'fail', detail: `${why}｜${nav.moved ? `${nav.via}：${nav.picked}` : `没找到对口岗位（试了 ${nav.tried.join('、') || '页面链接'}）`}` })
    if (nav.moved) { progress(`找到岗位「${nav.picked}」`, 'entry', nav.picked); return true }
    lastSeekTried = nav.tried
    // 自主找路一份网申只走一趟：模型回合要花时间和钱，一趟没到就如实报
    if (!opts.pathfinder || pathfinderUsed) return false
    pathfinderUsed = true
    progress('换个方式找：一步一步在网站上找对口岗位', 'entry')
    const auto = await opts.pathfinder(why).catch(e => { log(`自主找路出错：${e instanceof Error ? e.message : String(e)}`); return { moved: false, note: undefined } })
    recorder.trace({ stage: 'entry', action: 'pathfinder', result: auto.moved ? 'info' : 'fail', detail: auto.note ?? (auto.moved ? '到了' : '没到') })
    if (!auto.moved && auto.note) lastSeekNote = auto.note
    return auto.moved
  }

  try {
    try { libraries = libraryList(await page.evaluate(libraryFingerprintScript)) } catch { /* ignore */ }
    recorder.trace({ stage: 'start', result: 'info', detail: `${page.url()} | 组件库：${libraries.join(',') || '未识别'} | 适配器：${adapter.id}` })
    if (adapter.preprocess) await adapter.preprocess(page).catch(e => log(`预处理失败：${e instanceof Error ? e.message : e}`))
    for (let index = 1; index <= maxPages; index++) {
      // 0. 风险锁（网站拦过才有；没有每日上限，用户 2026-10-30「不要做上限」）
      if (opts.riskGuard) {
        const s = opts.riskGuard.shouldStop()
        if (s.stop) return finish('blocked', `风险守卫要求停止：${s.reason}${s.detail ? '（' + s.detail + '）' : ''}`)
        opts.riskGuard.countPage()
      }
      // 1. 阻碍检测
      let sig = await step('读取页面信号', () => readSignalsSettled(page, Math.max(opts.settleMs ?? 800, 0)))
      const verification = await verifyBeforeContinuing(page, sig, opts.verify)
      sig = verification.signals
      if (verification.blocked) return handoff(detectObstacle(sig, adapter)?.reason ?? 'captcha', sig, '自动验证未完成', '请在当前页完成验证后继续：')
      const risk = opts.riskGuard?.inspect(sig, adapter) ?? null
      // 导航栏的「登录/注册」不是登录墙：还没找岗位之前先去找（2026-10-31：北森 zhiye 首页一打开就被当成要登录）
      const rawOb = detectObstacle(sig, adapter)
      const ob = rawOb && opts.target && untouched() && !entryClicked && isNavLoginLink(rawOb) ? null : rawOb
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

      // 1.8 列表页 / 首页：页面上有这个站的岗位详情链接、却没有申请入口 → 先去找岗位。
      // 列表页左边的「职位类别 / 城市」筛选框不是网申表（2026-10-31 实例测试：小鹏列表页的筛选被当成表单填了）
      // 适配器认得出这是校招首页 / 列表页（能拼出站内搜索网址、自己又不是岗位详情）也一样：Moka 首页的搜索框标签常被认成标语
      // 只在一开始（还没点过申请入口、还没找过岗位）判断；点进网申表以后同一站的网址也拼得出搜索网址，不能再跳走
      // 列表页例外：飞书首页的「立即投递」点进去是招聘项目的岗位列表，还得再挑岗位
      // 详情页 = 只有一个申请入口，或网址本身就是岗位详情；列表页每张岗位卡上都有「立即投递」（Moka），不能当详情页
      const entries = sig.buttons.filter(b => !b.disabled && isDetailEntryText(b.text, adapter))
      // 详情页上下各放一个同样的申请按钮（滴滴「申请职位」、字节「投递」）：按网址认，网址就是某一个岗位的就是详情页（2026-11-02 真实站点被当成列表页、去站内乱找）
      const looksDetail = entries.length === 1 || !!adapter.hints.positionLink?.test(page.url()) || (new Set(entries.map(b => b.text.replace(/\s+/g, ''))).size === 1 && POSITION_URL_RX.test(page.url()))
      if (index === 1 && navHops === 0 && !looksDetail) {
        const here = page.url()
        const atHome = !entryClicked && !!adapter.positionSearchUrl?.(here, '') && !adapter.hints.positionLink?.test(here)
        const links = adapter.hints.positionLink ? await page.evaluate(positionLinksScript, null).catch(() => [] as PositionLink[]) : []
        const onList = entries.length >= 2 || links.some(l => adapter.hints.positionLink!.test(l.href))
        if (atHome || onList) {
          if (await seek(atHome ? '校招首页' : '列表页')) { index--; continue }
          // 已经认定这是首页 / 列表页、又走不出去：这里没有网申表。绝不把列表上的筛选、分页当表单填，
          // 也不把岗位卡上的「立即投递」当成提交按钮（2026-10-31：大众校招列表页又被报成「已填完，停在立即投递前」）
          if (opts.target) { pages.push(rec); return finish('blocked', lastSeekNote ?? `这家现在没有和你方向对口的岗位（站内找过：${lastSeekTried.join('、') || '页面上的岗位'}）`) }
        }
      }
      // 2. 抽取（L1）；抽不到且有感知器 → L2 视觉伪字段
      let fields = await step('抽取字段', () => extractFields(page))
      let layer: DriveLayer = 'dom'
      rec.fieldCount = fields.length
      // 2.05 第一页只有搜索框 / 筛选框（Moka 首页的「输入职位关键字」、列表页的城市筛选）：不是网申表，先去找岗位
      if (index === 1 && fields.length && (onlySearchOrFilter(fields) || filterBarOnly(fields)) && !sig.buttons.some(b => !b.disabled && isDetailEntryText(b.text, adapter))) {
        if (await seek('只有搜索 / 筛选框')) { index--; continue }
        // 找过了还是只有筛选框：这不是网申表，绝不当成「填好了」交去提交（2026-10-31：大众校招搜索页的筛选被报成表单已填完）
        if (opts.target) { pages.push(rec); return finish('blocked', lastSeekNote ?? `这家现在没有和你方向对口的岗位（站内找过：${lastSeekTried.join('、') || '页面上的岗位'}）`) }
      }
      // 2.1 岗位详情页：页面上没有任何表单字段、这次也没填过东西 → 允许点申请入口按钮进入网申表（最终提交仍永不点）
      // 北森 zhiye 的岗位行点开是就地展开、行里出「投递」：页面上只有搜索框 / 没标签的格子时也算「还没有表单」
      // 详情页上常有订阅邮箱、站内搜索这类格子：没有一个像网申表的格子（无必填、无姓名 / 手机 / 学校 / 简历…）也算还没进表（2026-11-02 蔚来真实站点）
      if ((!fields.length || onlySearchOrUnlabeled(fields) || !looksLikeApplicationForm(fields)) && untouched() && opts.allowEntryClick !== false && entryClicks < 2) {
        const entry = sig.buttons.find(b => !b.disabled && isEntryText(b.text, adapter))
        // 「立即投递 / 投递简历」这类按钮可能是一键投递，永远不点；但它若只是个链接（<a href> 去网申表），跟着链接走只是打开页面（2026-11-02 真实站点）
        const entryLink = entry ? undefined : sig.buttons.find(b => !b.disabled && !!b.href && isDetailEntryText(b.text, adapter))
        if (entry || entryLink) captureJd(sig.text)
        if (entryLink?.href && untouched()) {
          entryClicks++
          progress(`打开「${entryLink.text}」指向的网申页`, 'entry', entryLink.text)
          recorder.trace({ stage: 'entry', action: 'navigate', result: 'info', detail: `${entryLink.text} → ${entryLink.href}` })
          try {
            await page.goto(entryLink.href)
            entryClicked = entryLink.text
            await humanDelay(pause[0], pause[1], opts)
            index--
            continue
          } catch (e) {
            const c = classifyError(e)
            recorder.trace({ stage: 'entry', action: 'navigate', result: 'fail', code: c.code, detail: c.raw })
          }
        }
        // 学历要求高于他：不点投递，交给自主找路换一个岗位（2026-10-31：天翼云「超级优才」要博士，本科生差点投出去）
        const over = entry ? requiredAbove(sig.text, opts.target?.tooHigh ?? []) : undefined
        if (over) {
          log(`岗位要求「${over}」，高于你的学历，不投这个`)
          if (opts.pathfinder && !pathfinderUsed) {
            pathfinderUsed = true
            const auto = await opts.pathfinder(`这个岗位要求${over}，换一个`).catch(() => ({ moved: false, note: undefined }))
            if (auto.moved) { index--; continue }
            if (auto.note) lastSeekNote = auto.note
          }
          pages.push(rec)
          return finish('blocked', lastSeekNote ?? `这个岗位要求${over}，高于你的学历，没有投`)
        }
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
      // DOM 里没有表单：先看是不是首页 / 合集页（去找岗位），再交给视觉层——首页的轮播、登录框会被视觉当成输入框
      if (!fields.length && index === 1 && await seek('DOM 没有表单')) { index--; continue }
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
          // 接管交回后续跑、他已经点到了确认页（没有格子只剩「确认提交」）：停在提交前等他，不当详情页的入口
          const confirmBtn = opts.resumed ? findFinalSubmit(sig.buttons, adapter) : undefined
          if (confirmBtn && !isDetailEntryText(confirmBtn.text, adapter)) { pages.push(rec); return finish('stopped_before_submit', `停在「${confirmBtn.text}」前，等你确认后再提交`, { submitButton: confirmBtn.text, reason: 'submit_confirm' }) }
          // 首页 / 合集页：先去找对口的具体岗位，进了详情页再走上面的申请入口
          if (await seek('没有表单')) { index--; continue }
          pages.push(rec); all.escalations.push(...rec.escalations)
          const entry = sig.buttons.find(b => isDetailEntryText(b.text, adapter)) ?? findFinalSubmit(sig.buttons, adapter)
          return entry ? entryHandoff(entry.text) : finish('blocked', lastSeekNote ?? '页面上没有可填写的表单字段', { pageText: sig.text.slice(0, PAGE_TEXT_MAX) })
        }
        break // 后续页没字段：可能到了确认页
      }
      rec.layer = layer
      layersUsed.add(layer)
      sensitive = fields.filter(f => isSensitiveLabel(f.label) && f.layer !== 'vision').map(f => f.selector)
      // 组件库指纹按页累积（详情页和表单页往往不一样）
      try { libraries = [...new Set([...libraries, ...libraryList(await page.evaluate(libraryFingerprintScript)), ...fields.map(f => f.framework).filter((x): x is string => !!x && x !== 'native')])] } catch { /* ignore */ }
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
      /** 规划时的字段（后面重新抽取会按页面顺序重编 id，byId 会被覆盖；计划始终按这份认格子）。 */
      const planFields = new Map(byId)
      // 宁空不错：标签可疑（吸顶栏文字 / 纯数字 / 没标签）的字段不按它填
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (f?.labelUncertain && p.status === 'fill' && !f.isFile) {
          recorder.trace({ stage: 'plan', field: f.id, label: f.label, result: 'skip', code: 'label_uncertain', detail: f.labelUncertain })
          Object.assign(p, { status: 'needs_user', value: undefined, code: 'label_uncertain', note: `${reasonText('label_uncertain')}（${f.labelUncertain}）` })
        }
      }
      /** 本页已写过（或尝试写过）的字段：分区填写、复核都不再写不同来源的值。 */
      // 按"格子"记（slotOf），不按 id：分区加一行后 id 会顺移，按 id 记会把新行当成"写过 / 计划过"、复核也会对错格子
      const written = new Map<string, { value: string; stage: string }>()
      /** 每条填写记录对应的格子（写入那一刻的字段），复核按它认回。 */
      const fieldOf = new WeakMap<object, FormField>()
      /** 因为联动没解锁（控件禁用 / 下拉还是空的）而失败的格子：主循环填完后再试一次。 */
      const disabledQueue: Array<{ f: FormField; value: string; source: FieldPlan['source'] }> = []
      const record = (f: FormField, value: string, source: FieldPlan['source'], att: FieldAttempt, stage: string) => {
        if (!att.verified && (att.code === 'field_disabled' || att.code === 'options_empty') && (stage === 'field' || stage === 'section')) disabledQueue.push({ f, value, source })
        written.set(slotOf(f), { value, stage })
        // 网站锁定的格子记页面上的真值，不记我们打算填的（提交前比对改动时才不会误报）
        const kept = att.verified && att.strategy === 'locked-prefilled' && att.display ? att.display : value
        if (att.verified) { rec.filled.push({ fieldId: f.id, label: f.label, value: kept, source, layer: att.strategy === 'vision' ? 'vision' : 'dom', verified: true, strategy: att.strategy, display: att.display }); fieldOf.set(rec.filled[rec.filled.length - 1], f) }
        else if (att.rollback === 'failed') { rec.mismatches.push({ fieldId: f.id, label: f.label, expected: value, actual: att.display, code: att.code ?? 'readback_mismatch', reason: att.reason ?? reasonText(att.code) }); fieldOf.set(rec.mismatches[rec.mismatches.length - 1], f) }
        else { rec.needsUser.push({ fieldId: f.id, label: f.label, status: 'needs_user', source, confidence: 0, note: att.reason ?? reasonText(att.code), code: att.code ?? 'readback_mismatch' }); fieldOf.set(rec.needsUser[rec.needsUser.length - 1], f) }
      }

      // 4. 先上传简历（上传后页面可能弹"是否解析附件"、自动填充，过一遍障碍层再重新抽取）
      let uploaded = false
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (!f || !f.isFile || p.status !== 'fill' || !p.value) continue
        try {
          progress(`上传简历（${extname(p.value).slice(1).toUpperCase() || '文件'}）`, 'upload', f.label)
          let areaBefore: UploadAreaResult | undefined
          try { areaBefore = await page.evaluate(uploadAreaScript, { selector: f.selector }) } catch { areaBefore = undefined }
          const textBefore = await page.evaluate(pageSignalsScript).then(x => x.text).catch(() => '')
          await page.setInputFiles(f.selector, p.value)
          await humanDelay(pause[0] * 2, pause[1] * 2, opts)
          if (!(await blockers('after_upload', rec)) && unresolvedBlocker) { pushPage(); return blockerHandoff(unresolvedBlocker) }
          const check = await checkUploadEcho(page, f, p.value, areaBefore, textBefore)
          rec.uploads.push(check)
          rec.filled.push({ fieldId: f.id, label: f.label, value: basename(p.value), source: p.source, layer: 'dom', verified: check.echoed, strategy: 'upload' })
          written.set(slotOf(f), { value: p.value, stage: 'upload' })
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

      const deferred: FieldPlan[] = []
      const ranges = layer === 'dom' ? rangeFieldIds(fields) : new Set<string>()
      // 5. 逐字段：填写 + 核验 + 失败回滚（只填与当前值不同的；高影响缺答案 / 草稿不填）
      for (const p of plans) {
        const f = byId.get(p.fieldId)
        if (!f) continue
        // 起止范围控件（一个标签管两格）：逐格解释分不清开始 / 结束，交给 5.5 分区按行填
        if (ranges.has(f.id) && p.status !== 'skip') { deferred.push(p); continue }
        // 经历分区行里的「描述 / 工作内容」：用这段经历确认过的说法由 5.5 分区填，不当开放题起草（分区没填上再退回草稿）
        if (p.status === 'draft_needs_confirm' && layer === 'dom' && isRowDescription(f)) { deferred.push(p); continue }
        if (p.status === 'needs_user') {
          // 资料里找不到、但标签是分区行字段（如「在校时间」=入学）：先留给重复分区按行填，分区也没填上再记"要你补"
          if (p.source === 'none' && layer === 'dom' && !f.labelUncertain && SECTIONS.some(spec => matchRowField(f.label, spec))) { deferred.push(p); continue }
          rec.needsUser.push(p); continue
        }
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
            written.set(slotOf(f), { value: p.value, stage: 'prefilled' })
            rec.filled.push({ fieldId: f.id, label: f.label, value: p.value, source: p.source, layer: 'dom', verified: true, strategy: 'already', display: display || f.value })
            fieldOf.set(rec.filled[rec.filled.length - 1], f)
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

      // 5.2 联动重试：后面的选择可能刚解锁前面被禁用的格子（如"专业"要等"学历"选了才能选）。每个格子只重试一次。
      const retryDisabled = async () => {
        const queue = disabledQueue.splice(0)
        for (const q of queue) {
          const idx = rec.needsUser.findIndex(r => fieldOf.get(r) === q.f)
          const att = await fillAndVerify(fillDeps, q.f, q.value, 'field-retry')
          if (!att.verified) {
            recorder.trace({ stage: 'field-retry', field: q.f.id, label: q.f.label, result: 'fail', code: att.code, detail: '联动后重试仍未成功' })
            // 还灰着：留着等后面那几轮（按资料挑了学院、分区加了行之后）再试；重试只在固定的几处跑，不会打转
            if (att.code === 'field_disabled' || att.code === 'options_empty') disabledQueue.push(q)
            continue
          }
          if (idx >= 0) rec.needsUser.splice(idx, 1)
          record(q.f, q.value, q.source, att, 'field-retry')
        }
      }
      await retryDisabled()

      // 5.2b 自定义下拉在解释时还没有选项（要点开才出现）：现在点开读选项，按资料依据挑（专业 → 学院），填上后再解锁后面的格子
      //（2026-11-02 美团：学院名称有「计算机学院」却整格推给用户，专业名称因此一直是灰的）
      const unknownSelects = rec.needsUser.filter(n => n.note === '无法从资料确定' && byId.get(n.fieldId)?.type === 'select')
      if (unknownSelects.length && layer === 'dom') {
        const withOptions = (await attachOptions(page, unknownSelects, log)).filter(n => n.options?.length)
        const asFields = withOptions.flatMap(n => { const f = byId.get(n.fieldId); return f ? [{ ...f, options: n.options! }] : [] })
        for (const p of asFields.length ? await chooseFromEvidence(llm, asFields, profile) : []) {
          const f = byId.get(p.fieldId)
          if (!f || p.status !== 'fill' || !p.value) continue
          const att = await fillAndVerify(fillDeps, f, p.value, 'evidence')
          if (!att.verified) continue
          const idx = rec.needsUser.findIndex(n => n.fieldId === p.fieldId && n.label === p.label)
          if (idx >= 0) rec.needsUser.splice(idx, 1)
          record(f, p.value, 'profile', att, 'evidence')
          log(`「${f.label}」按资料选了「${p.value}」（${p.note ?? ''}）`)
        }
        await retryDisabled()
      }

      // 5.3 前面的选择让页面多出了格子（选了「英语」才出现「语言考试 / 分数」）：重新抽取，只解释、填写之前没规划过的格子，最多两轮
      if (layer === 'dom') {
        const known = new Set(Array.from(planFields.values()).map(slotOf))
        for (let round = 0; round < 2; round++) {
          let now: FormField[]
          try { now = await step('抽取字段', () => extractFields(page)) } catch { break }
          const fresh = now.filter(f => !f.isFile && !known.has(slotOf(f)) && !written.has(slotOf(f)))
          if (!fresh.length) break
          for (const f of fresh) { known.add(slotOf(f)); planFields.set(f.id, f); byId.set(f.id, f) }
          // 新出现的起止格子同样交给 5.5 分区按行认开始 / 结束（2026-10-31 小鹏整表重渲染后两格又都成了毕业时间）
          for (const id of rangeFieldIds(now)) ranges.add(id)
          recorder.trace({ stage: 'revealed', result: 'info', detail: `新出现 ${fresh.length} 格：${fresh.map(f => f.label || '?').join(' | ')}` })
          log(`前面的选择让页面新出现了 ${fresh.length} 格：${fresh.map(f => f.label || '?').join('、')}`)
          const more = await interpretForm(llm, fresh, profile, { adapter, recallKey, ...opts.interpret })
          if (opts.resolveValue) for (const p of more) if (p.status === 'fill' && p.value !== undefined) p.value = opts.resolveValue(p.value)
          for (const p of more) {
            const f = byId.get(p.fieldId)
            if (!f) continue
            if (f.labelUncertain && p.status === 'fill') { rec.needsUser.push({ ...p, status: 'needs_user', value: undefined, code: 'label_uncertain', note: `${reasonText('label_uncertain')}（${f.labelUncertain}）` }); continue }
            plans.push(p)
            if (ranges.has(f.id) && p.status !== 'skip') { deferred.push(p); continue }
            if (p.status === 'draft_needs_confirm' && isRowDescription(f)) { deferred.push(p); continue }
            if (p.status === 'needs_user') { rec.needsUser.push(p); continue }
            if (p.status === 'draft_needs_confirm') { rec.drafts.push(p); continue }
            if (p.status !== 'fill' || p.value === undefined) continue
            progress(`正在填「${f.label}」`, 'field', f.label)
            record(f, p.value, p.source, await fillAndVerify(fillDeps, f, p.value, 'field'), 'field')
            await humanDelay(pause[0], pause[1], opts)
          }
          await retryDisabled()
        }
      }

      // 5.5 重复分区（教育 / 实习工作 / 项目经历的"表格"）：逐行填，不够就点"添加一行"再填新出现的那一行（只在 DOM 层）
      if (layer === 'dom') {
        try {
          if (!(await blockers('section', rec)) && unresolvedBlocker) { pushPage(); return blockerHandoff(unresolvedBlocker) }
          // 重新抽取：拿到第 5 步填完后的当前值，已有值的行不覆盖
          fields = await step('抽取字段', () => extractFields(page)); for (const f of fields) byId.set(f.id, f)
          const planned = new Set(plans.filter(p => p.status !== 'skip' && !deferred.includes(p)).map(p => planFields.get(p.fieldId)).filter((f): f is FormField => !!f).map(slotOf))
          const sec = await fillRepeatingSections(page, fields, profile, {
            fill: async (f, v) => {
              const att = await fillAndVerify(fillDeps, f, v, 'section')
              record(f, v, 'profile', att, 'section')
              return att.verified
            },
            // 同一字段只写一次：字段阶段已写过 / 计划过的不再由分区写入
            skip: f => written.has(slotOf(f)) || planned.has(slotOf(f)) || !!f.labelUncertain,
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
      await retryDisabled() // 分区里新加的行同样有联动（第二段学历选了，专业才解锁）
      // 起止格子分区没填上：按所在经历 / 模型认出是哪一段再填，不交给人（range-fallback.ts）
      const rangeLeft = new Set(deferred.filter(p => { const f = planFields.get(p.fieldId); return ranges.has(p.fieldId) && !!f && !written.has(slotOf(f)) }).map(p => p.fieldId))
      if (rangeLeft.size) {
        const planned = [...planFields.values()]
        for (const r of await resolveRangeValues(planned, rangeLeft, ranges, profile, widgetLlm, log)) {
          const old = planFields.get(r.fieldId)
          const f = old && (fields.find(x => slotOf(x) === slotOf(old)) ?? old)
          if (!f) continue
          record(f, r.value, 'profile', await fillAndVerify(fillDeps, f, r.value, 'range'), 'range')
        }
      }
      for (const p of deferred) {
        const f = planFields.get(p.fieldId)
        if (f && written.has(slotOf(f))) continue
        if (p.status === 'draft_needs_confirm') { rec.drafts.push(p); continue }
        if (ranges.has(p.fieldId)) log(`[apply-gap] 起止格子「${p.label}」认不出属于哪段经历`)
        rec.needsUser.push(p.status === 'needs_user' ? p : { ...p, status: 'needs_user', value: undefined, confidence: 0, note: reasonText('fill_error') })
      }

      // 6. 整页复核（只对 DOM 层）：核验通过的值有没有被页面后来的动作冲掉（如上传解析回填、联动清空）；冲掉的重填一次，再不行就清空留给用户
      if (layer === 'dom') {
        const after = await step('抽取字段', () => extractFields(page))
        const verifiedNow = rec.filled.filter(r => r.verified && r.strategy !== 'upload' && !byId.get(r.fieldId)?.isFile)
        // 重新抽取会按页面顺序重新编号：分区里加了一行，后面字段的 id 全部顺移。复核必须按"同一个格子"
        // （同名标签 + 同一 xpath / name）认回字段，认不准就不碰——宁可不复核，也不把值写进别的格子。
        for (const r of verifiedNow) {
          const orig = fieldOf.get(r)
          const key = orig && stableSlot(orig)
          const hits = key ? after.filter(x => stableSlot(x) === key) : []
          if (hits.length !== 1) {
            recorder.trace({ stage: 'recheck', field: r.fieldId, label: r.label, result: 'skip', code: 'element_missing', detail: hits.length ? `认出 ${hits.length} 个同名格子，不复核` : '页面变了，认不回这个格子，不复核' })
            continue
          }
          const f = hits[0]
          const display = await readDisplay(page, f)
          if (displayMatches(display, r.value, f)) continue
          const idx = rec.filled.indexOf(r)
          rec.filled.splice(idx, 1)
          recorder.trace({ stage: 'recheck', field: f.id, label: f.label, result: 'fail', code: 'readback_mismatch', detail: `复核时显示「${display}」` })
          const att = await fillAndVerify(fillDeps, f, r.value, 'recheck')
          record(f, r.value, r.source, att, 'recheck')
        }
        // 站点记忆：读回核对通过的 profile 字段，记下"这站这个字段 ↔ 资料键"，下次别名匹配不到也能直填
        if (opts.siteMemory) {
          const good = new Set(rec.filled.filter(r => r.verified).map(r => r.fieldId))
          for (const p of plans) {
            const f = byId.get(p.fieldId)
            if (!f || !p.key || p.status !== 'fill' || !good.has(p.fieldId)) continue
            // 这一格现在的标题得和规划时是同一个：格子号错过位的话，读回「对上」的其实是别的格（2026-11-03 库洛游戏把「游戏经历 = 学历」记进了站点记忆）
            if (normKey(f.label) !== normKey(p.label)) { log(`站点记忆跳过：规划时是「${p.label}」，这一格现在是「${f.label}」`); continue }
            opts.siteMemory.remember(host, { name: f.name, xpath: f.xpath, label: f.label }, p.key, p.note === '按站点记忆匹配' ? 'learned' : 'alias')
            all.memorized++
          }
        }
        // 记录里的 fieldId 来自不同次抽取（规划时 / 分区加行后），统一换算到这次抽取的 id 再出状态表；
        // 认不回格子的记录标成失效 id，绝不挂到别的字段上
        if (after.length) {
          for (const list of [rec.filled, rec.needsUser, rec.mismatches, rec.drafts] as Array<Array<{ fieldId: string }>>) {
            for (const r of list) {
              const orig = fieldOf.get(r) ?? planFields.get(r.fieldId)
              const key = orig && stableSlot(orig)
              const hit = key ? after.find(x => stableSlot(x) === key) : undefined
              if (hit) r.fieldId = hit.id
              else if (orig && !after.some(x => x.id === r.fieldId && x.label === orig.label)) r.fieldId = `gone:${r.fieldId}`
            }
          }
        }
        rec.fields = outcomesFor(index, after.length ? after : fields, rec)
      } else rec.fields = outcomesFor(index, fields, rec)
      sig = await step('读取页面信号', () => page.evaluate(pageSignalsScript))
      const verified = await verifyBeforeContinuing(page, sig, opts.verify)
      sig = verified.signals
      rec.errors = sig.errors
      if (verified.blocked) { pushPage(); return handoff(detectObstacle(sig, adapter)?.reason ?? 'captcha', sig, '自动验证未完成', '请在当前页完成验证后继续：') }
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
        const confirmPage = !!opts.resumed && !!submit && !isDetailEntryText(submit.text, adapter)
        if (untouched() && !confirmPage) return submit ? entryHandoff(submit.text) : finish('blocked', lastSeekNote ?? '页面上没有找到可填写的网申表单，也没有下一步或提交按钮', { pageText: sig.text.slice(0, PAGE_TEXT_MAX) })
        // 一格都没填成、要补的全是截图识字层点不进去的「格子」、也没有提交按钮：这不是网申表（多是岗位列表），
        // 如实报找路的结论，不说「表单已填完」（2026-10-31 阿斯麦：岗位卡片上的字被当成输入框）
        // 同理：一格都没填上、也没传文件、又没有提交按钮——多半是岗位列表 / 介绍页上的搜索框、订阅邮箱框被当成了格子
        // （2026-11-06 司南导航校招列表页：报「表单已填完」，还让他补「请输入邮箱地址」）
        const nothingDone = !all.filled.length && !all.uploads.length && !all.drafts.length
        if (!submit && (visionOnlyMisses() || nothingDone)) return finish('blocked', lastSeekNote ?? '页面上没有找到可填写的网申表单，也没有下一步或提交按钮', { pageText: sig.text.slice(0, PAGE_TEXT_MAX) })
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
    // 运行记录没落盘时（遥测关着 / 目录没建）原始报错会只剩一句「填写时出错了」：日志里也留一份
    console.warn(`[apply-drive] crash url=${page.url()} code=${c.code}: ${String(c.raw).slice(0, 400)}${e instanceof Error && e.stack ? `\n${e.stack.split('\n').slice(1, 5).join('\n')}` : ''}`)
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

/** 页面刚打开就自己跳转（北森 zhiye 首页会跳到栏目页）时，第一次读页面会撞上「执行上下文被销毁」：等一下再读。 */
const NAV_RACE_RX = /Execution context was destroyed|navigat/i
const SIGNAL_RETRIES = 2
async function readSignalsSettled(page: PageLike, settleMs: number): Promise<PageSignals> {
  for (let attempt = 0; ; attempt++) {
    try { return await page.evaluate(pageSignalsScript) } catch (error) {
      if (attempt >= SIGNAL_RETRIES || !NAV_RACE_RX.test(error instanceof Error ? error.message : String(error))) throw error
      await page.waitForTimeout(Math.max(settleMs, 500) * 2)
    }
  }
}

const SEARCH_FILTER_RX = /(搜索|关键字|关键词|keyword|search|筛选|职位类别|职位类型|工作地点|城市|地点|所属部门|职能类型|行\/页|条\/页|每页|排序)/i
/** 列表页 / 首页上的搜索框和筛选项，不是网申表的格子。 */
function isSearchOrFilterField(f: FormField): boolean {
  return SEARCH_FILTER_RX.test(`${f.label} ${f.placeholder ?? ''}`)
}
/** 这一页只有搜索 / 筛选（没标签的格子不算反证，但至少要有一个认得出是筛选的）。 */
function onlySearchOrFilter(fields: FormField[]): boolean {
  return fields.some(isSearchOrFilterField) && fields.every(f => isSearchOrFilterField(f) || !`${f.label}${f.placeholder ?? ''}`.trim())
}
/** 页面上写着高于他的学历门槛（「博士研究生及以上」）；后面跟「优先」的只是偏好，不算门槛。 */
export function requiredAbove(text: string, words: readonly string[]): string | undefined {
  for (const w of words) {
    let at = text.indexOf(w)
    while (at >= 0) {
      if (!text.slice(at + w.length, at + w.length + 4).includes('优先')) return w
      at = text.indexOf(w, at + w.length)
    }
  }
  return undefined
}
/** 网申表的痕迹：个人 / 联系 / 教育类格子、简历上传，或者必填星号。 */
const APPLICATION_FIELD_RX = /(姓名|手机|电话|邮箱|证件|身份证|性别|出生|民族|籍贯|学校|院校|学历|学位|专业|毕业|简历|附件|name|phone|mobile|email|school|degree|major|resume|cv)/i
function looksLikeApplicationForm(fields: FormField[]): boolean {
  return fields.some(f => f.isFile || f.required || APPLICATION_FIELD_RX.test(`${f.label} ${f.placeholder ?? ''}`))
}
/**
 * 筛选栏：没有任何网申表的痕迹，格子又全是下拉 / 搜索框 / 没标签的——按结构认，不靠筛选词表
 * （2026-10-31 韶音 Moka 列表页的「职位性质 / 职能类型」不在词表里，被当成网申表去填）。
 */
function filterBarOnly(fields: FormField[]): boolean {
  return !looksLikeApplicationForm(fields) && fields.every(f => f.type === 'select' || f.custom || isSearchOrFilterField(f) || !`${f.label}${f.placeholder ?? ''}`.trim())
}
/** 只有搜索 / 筛选 / 没标签的格子（没有一个像网申表的格子）。 */
function onlySearchOrUnlabeled(fields: FormField[]): boolean {
  return fields.every(f => isSearchOrFilterField(f) || !`${f.label}${f.placeholder ?? ''}`.trim())
}
/** 只因为页面文字里有导航栏那种「登录 / 注册」才判成登录墙（没有密码框、不是登录网址）。 */
function isNavLoginLink(ob: Obstacle): boolean {
  return ob.reason === 'login' && /^登录\s*\/\s*注册$/.test(ob.evidence.trim())
}

/** 点击前最后一道防线：文案像提交就拒绝。 */
async function clickButton(page: PageLike, b: ButtonInfo, adapter: SiteAdapter): Promise<void> {
  if (isSubmitText(b.text, adapter)) throw new Error(`拒绝点击提交类按钮「${b.text}」`)
  await page.click(b.selector)
}
/** 申请入口：只认入口文案（立即申请 / 申请职位 / 我要投递 / Apply…），且调用方已确认页面上没有表单字段。 */
async function clickEntry(page: PageLike, b: ButtonInfo, adapter: SiteAdapter): Promise<void> {
  if (!isEntryText(b.text, adapter)) throw new Error(`「${b.text}」不是申请入口按钮`)
  const detailEntry = (adapter.hints.detailEntryWords ?? []).some(w => normKey(w) === normKey(b.text))
  if (!detailEntry && (adapter.hints.submitWords ?? []).some(w => normKey(w) === normKey(b.text)) && !/申请|apply/i.test(b.text)) throw new Error(`「${b.text}」是该站的提交按钮`)
  await page.click(b.selector)
}

/** 格子的稳定身份：标签 + 类型 + xpath（没有就用 name）。两者都没有返回 null：认不准，复核不碰它。 */
function stableSlot(f: FormField): string | null {
  const where = f.xpath || f.name
  return where ? `${f.label}\u0001${f.type}\u0001${where}` : null
}
/** 去重用的格子键：认不准时退回到本次抽取的 id（只在同一次抽取内去重，不跨抽取复用）。 */
function slotOf(f: FormField): string { return stableSlot(f) ?? `id:${f.id}` }

/** 经历分区行里的描述格（「描述」「工作内容」「项目描述」）。 */
function isRowDescription(f: FormField): boolean {
  return SECTIONS.some(spec => matchRowField(f.label, spec) === 'description')
}

function sameValue(f: FormField, v: string): boolean {
  if (f.value === undefined || f.value === '') return false
  if (f.type === 'checkbox') return (f.value === 'true') === /^(true|1|yes|是)$/i.test(v)
  // 只有选项类才按去标点的宽松写法比；自由文本交给 displayMatches 严格比（标点不同就是没填对）
  if ((f.type === 'select' || f.type === 'radio') && normKey(f.value) === normKey(v)) return true
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
/**
 * 上传回显（不认类名，上传前后对比）：页面 / 上传区出现文件名（原名、全半角与各种横线归一、去扩展名的主干）、
 * "上传成功 / 已上传 / 重新上传 / 删除"等提示新出现、上传区多出带扩展名的文件项，任一成立即算回显。
 * 站点上传是异步的（先弹"是否解析"、再传、再回显），所以轮询几秒。只有 input.files 有值不算（那只说明浏览器选了文件，
 * 站点上传失败也一样有值——算它就是假成功）。
 */
export const looseName = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\-‐‑‒–—―_－~·•.。、,，()（）[\]【】]/g, '')
export async function checkUploadEcho(page: PageLike, f: FormField, filePath: string, before?: UploadAreaResult, beforeText?: string): Promise<UploadCheck> {
  const name = basename(filePath)
  const ext = (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? '').toLowerCase()
  const full = looseName(name)
  const stem = looseName(name.replace(/\.[^.]+$/, ''))
  const SUCCESS = /(上传成功|已上传|解析成功|解析完成|简历解析|重新上传|uploaded|attached|upload complete|re-?upload)/i
  for (let i = 0; i < 12; i++) {
    // 注意：文件框自己的 files / value 只说明浏览器选了文件，站点没处理也会有值，不算回显
    const sig: PageSignals = await page.evaluate(pageSignalsScript)
    const text = looseName(sig.text)
    if (text.includes(full)) return { fieldId: f.id, file: name, echoed: true, evidence: '页面文本中出现文件名' }
    let area: UploadAreaResult | undefined
    try { area = await page.evaluate(uploadAreaScript, { selector: f.selector }) } catch { area = undefined }
    if (area) {
      const at = looseName(area.text)
      if (stem.length >= 2 && at.includes(stem)) return { fieldId: f.id, file: name, echoed: true, evidence: `上传区显示文件名：${area.text.slice(0, 80)}` }
      const changed = !before || area.text !== before.text
      const token = ext ? area.text.match(new RegExp(`[^\\s|/\\\\]{1,60}\\.${ext}\\b`, 'i'))?.[0] : undefined
      if (changed && token && !(before?.text ?? '').includes(token)) return { fieldId: f.id, file: name, echoed: true, evidence: `上传区新出现「${token}」（站点改写了文件名）` }
      if (changed && area.items > (before?.items ?? 0)) return { fieldId: f.id, file: name, echoed: true, evidence: '上传区新增了文件项' }
      const m = area.text.match(SUCCESS)
      if (changed && m && !SUCCESS.test(before?.text ?? '')) return { fieldId: f.id, file: name, echoed: true, evidence: m[0] }
    }
    const m = sig.text.match(SUCCESS)
    if (m && !SUCCESS.test(beforeText ?? '')) return { fieldId: f.id, file: name, echoed: true, evidence: m[0] }
    if (i < 11) await page.waitForTimeout(400)
  }
  return { fieldId: f.id, file: name, echoed: false, evidence: '页面没有出现文件名或上传成功提示，请人工确认附件' }
}

/**
 * 要他补的缺口：和服务端 studentGaps 同一套口径（needs_user / empty / draft），两处报的数才对得上
 * （2026-11-06 畅游：这里说「还差 8 项」，等你卡说「还差 16 项」）。读不回、没生效、网站报错是我们自己的问题，不算在要他补的里面。
 */
const STOP_GAP_STATUSES: ReadonlySet<string> = new Set(['empty', 'needs_user', 'draft'])
/** 停在提交前的那句话：没缺口照原话；有缺口就说还差哪几项，不说「已填完」。 */
export function stopMessage(original: string, review: Pick<SubmitReview, 'rows'>, submitButton?: string): string {
  const names = [...new Set(review.rows.filter(r => STOP_GAP_STATUSES.has(r.status)).map(r => r.label || '没认出名字的字段'))]
  if (!names.length) return original
  const where = submitButton ? `停在「${submitButton}」前` : '停在提交前'
  return `还差 ${names.length} 项没填好：${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}，${where}`
}
