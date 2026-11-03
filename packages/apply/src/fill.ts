import { extractJson, type LLM } from '@career/core'
import type { PageLike } from './page.js'
import { extractFields, radioOptionSelector, type FormField } from './extract.js'
import { fillValueScript } from './scripts.js'
import {
  activeEditableScript, clearSelectScript, closePopupScript, datePickScript, domSnippetScript, focusFieldScript, clearHighlightScript, openOptionsScript,
  pageSelectionScript, pickOptionScript, probeTargetScript, readDisplayScript, widgetSignatureScript, type OptionInfo, type ProbeResult,
} from './widgets.js'
import { classifyError, reasonText, withWatchdog, type FieldReasonCode } from './codes.js'
import { agentFill } from './field-agent.js'
import type { BoundWidgetMemory, WidgetPatch } from './memory.js'
import { formatDate, type DateStyle } from './normalize.js'
import { DATE_FIELD_RX, dictFor, matchOption, normalizeByDict, parseLooseDate } from './normalize.js'
import { fuzzyEquals, normKey, strictText } from './text.js'
import { humanDelay, type PacingOptions } from './pacing.js'
import { noopRecorder, type Recorder } from './telemetry.js'

/**
 * 单个字段的"填写 + 核验 + 失败回滚"。两重机制都在这里落地：
 *  第一重（做好）：先滚到正中并高亮 → 探测遮挡（被弹窗挡住先走障碍层）→ 按控件类型选策略：
 *    普通文本框键入 / fill；自定义下拉 点开 → 枚举选项 → 规范化 / 同义匹配（不确定再问模型）→ 点选；
 *    日期 能输入先输入，否则面板按 年 → 月（→ 日）导航；级联逐级。
 *  第二重（兜底，宁空不错）：
 *    - 只读 / 自定义控件绝不用原型链 setter 硬写（不会再有"读回相同就报成功"的假成功）；
 *    - 成功以"用户可见的显示值"读回为准；
 *    - 不可搜索的下拉绝不打字、不按回车；全选只在焦点就是目标且可编辑时才按；
 *    - 所有策略失败或读回不一致 → 清空回原值（清不掉标 rollback_failed），结果 needs_user + 原因码；
 *    - 每个字段一个看门狗超时。
 */
export interface FillDeps extends PacingOptions {
  page: PageLike
  pause: [number, number]
  humanTyping?: boolean
  llm?: LLM
  recorder?: Recorder
  progress?: (message: string) => void
  log?: (message: string) => void
  /** 每个字段的看门狗（毫秒）。 */
  watchdogMs?: number
  /** 被遮挡时调用障碍层；返回 false 表示有处理不了的弹窗。 */
  clearBlockers?: () => Promise<boolean>
  /** 遥测截图（已含打码），没有则不截。 */
  capture?: (name: string) => Promise<string | undefined>
  /** 是否高亮（实时画面跟随）。 */
  highlight?: boolean
  /** 站点控件记忆（已绑定 host）：同站同类控件优先用上次成功的做法。 */
  widgetMemory?: BoundWidgetMemory
  /** 模型接手（field-agent.ts）：结构树没办成、又不是真定论时交模型接着办；默认开，没有 llm 时不跑。 */
  semantic?: boolean
  /** 给模型接手时的打码截图（模型支持图片时附上）。 */
  snapshot?: () => Promise<Uint8Array | undefined>
}
export interface FieldAttempt {
  verified: boolean
  strategy: string
  /** 页面上用户可见的显示值（核验依据）。 */
  display?: string
  /** 下拉实际选中的选项文案。 */
  chosen?: string
  code?: FieldReasonCode
  /** 给用户看的中文原因。 */
  reason?: string
  /** 失败后的回滚结果。 */
  rollback?: 'restored' | 'failed' | 'none'
  ms?: number
}

const EMAIL_OK = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const isEmailField = (f: Pick<FormField, 'type' | 'label' | 'name'>) => f.type === 'email' || /邮箱|e-?mail/i.test(`${f.label} ${f.name ?? ''}`)

export const isDateLike = (f: Pick<FormField, 'type' | 'label' | 'placeholder'>) => f.type === 'date' || DATE_FIELD_RX.test(`${f.label} ${f.placeholder ?? ''}`) || /yyyy|年|月/i.test(f.placeholder ?? '')

/** 显示值与计划值是否一致（文本归一；下拉 / 字典同义；日期按数字；手机号按数字）。 */
export function displayMatches(display: string | undefined, value: string, f: Pick<FormField, 'label' | 'type' | 'maxLength'>, chosen?: string): boolean {
  const d = (display ?? '').trim()
  if (!d) return !value.trim()
  const choice = f.type === 'select' || f.type === 'radio'
  if (!choice) {
    // 自由填写的文本：标点必须一致（normKey 会去掉标点，"qq,com" 会被当成 "qq.com"，那就是假成功）
    const sd = strictText(d), sv = strictText(value)
    if (sd === sv) return true
    if (f.maxLength && sv.startsWith(sd) && sd.length >= Math.min(f.maxLength, sv.length)) return true
  }
  const nd = normKey(d), nv = normKey(value)
  if (choice && nd === nv) return true
  if (choice && chosen && (nd === normKey(chosen) || nd.includes(normKey(chosen)))) return true
  const dd = d.match(/\d+/g)?.map(Number) ?? [], vd = value.match(/\d+/g)?.map(Number) ?? []
  if (isDateLike(f as FormField) && vd.length >= 2 && dd.length >= 2 && dd[0] === vd[0] && dd[1] === vd[1] && (vd.length < 3 || dd[2] === vd[2])) return true
  if (/手机|电话|phone|mobile|tel/i.test(f.label) && d.replace(/\D/g, '').endsWith(value.replace(/\D/g, '')) && value.replace(/\D/g, '').length >= 7) return true
  if (f.type === 'select' || f.type === 'radio') return !!matchOption([d], value, { label: f.label })
  return false
}

/** learned：这次试出来的控件做法（写进站点控件记忆）。 */
type Outcome = Omit<FieldAttempt, 'ms' | 'rollback' | 'reason'> & {
  learned?: WidgetPatch
  /** 结构层认出的选项（给模型当线索）。 */
  seen?: string[]
}
const fail = (strategy: string, code: FieldReasonCode, display?: string): Outcome => ({ verified: false, strategy, code, display })

async function readDisplay(page: PageLike, f: FormField): Promise<string> {
  try { return (await page.evaluate(readDisplayScript, { selector: f.selector })).display } catch { return '' }
}

/** 点开后的列表至少这么长，才可能是只显示了一部分（远程 / 虚拟滚动），值得打字搜。 */
const SEARCH_WORTHY_OPTIONS = 20

async function llmPickOption(llm: LLM, label: string, value: string, options: OptionInfo[]): Promise<OptionInfo | undefined> {
  const list = options.filter(o => !o.disabled).slice(0, 80)
  if (!list.length) return undefined
  const system = '你在帮用户填网申表单的下拉框。给定字段名、用户资料里的值、下拉选项列表，选出与资料值意思完全相同的那一项（如"硕士"↔"硕士研究生"）。只有在确定是同一个意思时才选；没有对应项或拿不准就返回 null，绝不选"相近"的。只输出 JSON：{"index": 序号或 null}'
  try {
    const res = await llm.complete({ system, messages: [{ role: 'user', content: JSON.stringify({ field: label, value, options: list.map((o, i) => ({ i, text: o.text })) }) }], json: true, temperature: 0, maxTokens: 60 })
    const j = extractJson<{ index?: number | null }>(res.text)
    return typeof j.index === 'number' && Number.isInteger(j.index) ? list[j.index] : undefined
  } catch { return undefined }
}

function pickByText(options: OptionInfo[], value: string, label: string, strict = false): OptionInfo | undefined {
  const enabled = options.filter(o => !o.disabled)
  const hit = matchOption(enabled.map(o => o.text), value, { label })
  if (!hit) return undefined
  // 搜索出来的结果（学校 / 专业 / 城市）：只认同一个意思（相等 / 字典同义 / 错别字级别），
  // 不认"包含"——搜「西京大学」出来的「西京大学附属学院」不是同一所学校（宁空不错）
  if (strict && !sameMeaning(hit, value, label)) return undefined
  return enabled.find(o => o.text === hit)
}
function sameMeaning(option: string, value: string, label: string): boolean {
  if (normKey(option) === normKey(value) || fuzzyEquals(option, value)) return true
  const dict = dictFor(undefined, label)
  return !!dict && normalizeByDict(dict, option) === normalizeByDict(dict, value) && normalizeByDict(dict, value) !== value.trim()
}

async function typeInto(d: FillDeps, f: FormField, value: string): Promise<boolean> {
  const { page } = d
  // 键入前确认焦点就在目标上且可编辑；否则不按任何键（避免全选整页 / 写到别处）
  const focus = await page.evaluate(activeEditableScript, { selector: f.selector }).catch(() => null)
  if (!focus || !focus.editable || !focus.isTarget) return false
  for (const ch of Array.from(value)) {
    await page.keyboard!.type(ch)
    if (d.pause[1] > 0) await humanDelay(40, 140, d)
  }
  return true
}

async function fillText(d: FillDeps, f: FormField, value: string, probe: ProbeResult): Promise<Outcome> {
  const { page } = d
  if (!probe.editable) return fail('text', 'not_editable')
  let strategy = 'fill'
  if (d.humanTyping && page.keyboard) {
    strategy = 'type'
    await page.locator(f.selector).click()
    await page.fill(f.selector, '')
    if (!(await typeInto(d, f, value))) { strategy = 'fill'; await page.fill(f.selector, value) }
  } else await page.fill(f.selector, value)
  let display = await readDisplay(page, f)
  if (displayMatches(display, value, f)) return { verified: true, strategy, display }
  // 受控组件吞掉了程序化输入：原型链 setter（只在普通可编辑文本框上）
  const r = await page.evaluate(fillValueScript, { selector: f.selector, value, kind: 'text', fieldKey: `${f.label} ${f.name ?? ''}` }).catch(() => null)
  display = await readDisplay(page, f)
  if (r?.ok && displayMatches(display, value, f)) return { verified: true, strategy: 'native-setter', display }
  return fail(strategy, 'readback_mismatch', display)
}

async function widgetSig(d: FillDeps, f: FormField): Promise<string> {
  if (!d.widgetMemory) return ''
  try { return (await d.page.evaluate(widgetSignatureScript, { selector: f.selector })).sig } catch { return '' }
}

async function fillCustomSelect(d: FillDeps, f: FormField, value: string, sig: string): Promise<Outcome> {
  const { page } = d
  const known = sig ? d.widgetMemory?.recall(sig) : undefined
  const close = () => page.evaluate(closePopupScript, { selector: f.selector }).catch(() => {})
  // 先收起别的字段没关上的弹层，免得把它的选项当成这个字段的
  await close()
  let open = await page.evaluate(openOptionsScript, { selector: f.selector })
  const learned: WidgetPatch = { kind: 'select', popup: open.via }
  // 输入框可编辑 ≠ 能搜：记忆里说过"打字没反应"的同类控件直接当不可搜索
  const editable = open.searchable && known?.searchable !== false
  // 点开了但是空的（「无数据」）：联动选项往往在前一格选完后才异步加载，先等一会儿重读，不急着打字；
  // 还空且不能搜 → 交给联动重试
  if (open.opened && !open.options.length) open = await page.evaluate(openOptionsScript, { selector: f.selector, reopen: true, waitMs: 2500 })
  if (open.opened && !open.options.length && !editable) { await close(); return { ...fail('custom-select', 'options_empty'), learned } }
  if (!open.opened || (!open.options.length && !editable)) { await close(); return { ...fail('custom-select', 'options_not_found'), learned } }
  d.recorder?.trace({ stage: 'field', action: 'options_seen', label: f.label, result: 'info', detail: `${open.options.length} 项：${open.options.slice(0, 12).map(o => o.text).join(' | ')}` })
  const segments = value.split(/\s*[/／>＞]\s*/).filter(Boolean)
  const first = segments.length > 1 && open.cascade ? segments[0] : value
  // 先在点开后的列表里选：字典 / 文本匹配 → 匹配不上把整张列表交给模型按意思挑（"英语六级"↔"CET-6"）
  let opt = open.options.length ? pickByText(open.options, first, f.label) : undefined
  let strategy = 'option-click'
  if (!opt && d.llm && open.options.length) { opt = await llmPickOption(d.llm, f.label, first, open.options); if (opt) strategy = 'llm-option-click' }
  let typed = false
  // 只有列表是空的（远程搜索要先输关键字）或很长、可能只显示了一部分时才打字搜。短列表里没有就是没有，不打字。
  const mayBePartial = !open.options.length || open.options.length >= SEARCH_WORTHY_OPTIONS || !!open.partial
  // 可搜索探测（行为，不看类名）：先键入一两个字，看候选 / 弹层文字有没有变化；没变化 → 不可搜索，清空、不再打字。
  // 不可编辑（readonly）的输入框一个字都不打。搜出来的结果只认同一个意思，不按回车，仍然点选项
  if (!opt && editable && mayBePartial && page.keyboard) {
    const chars = Array.from(first)
    const head = known?.searchable ? chars.join('') : chars.slice(0, Math.min(2, chars.length)).join('')
    if (await typeInto(d, f, head)) {
      typed = true
      const beforeSig = `${open.options.map(o => o.text).join('|')}#${open.popupText ?? ''}`
      await page.waitForTimeout(300)
      let again = await page.evaluate(openOptionsScript, { selector: f.selector, reopen: true, waitMs: known?.searchable ? 3000 : 1800 })
      const reacted = `${again.options.map(o => o.text).join('|')}#${again.popupText ?? ''}` !== beforeSig
      if (!reacted && !known?.searchable) {
        d.recorder?.trace({ stage: 'field', action: 'search_probe', label: f.label, result: 'fail', detail: '键入后候选没有变化，按不可搜索处理' })
        await close(); await clearQuery(d, f)
        return { ...fail('custom-select', 'no_matching_option'), learned: { ...learned, searchable: false } }
      }
      learned.searchable = true
      if (head.length < chars.length && (await typeInto(d, f, chars.slice(Array.from(head).length).join('')))) {
        await page.waitForTimeout(300)
        again = await page.evaluate(openOptionsScript, { selector: f.selector, reopen: true, waitMs: 3000 })
      }
      open = again
      opt = pickByText(open.options, first, f.label, true)
      strategy = 'search-click'
    }
  }
  if (!opt) {
    d.recorder?.trace({ stage: 'field', action: 'options', label: f.label, result: 'fail', code: 'no_matching_option', detail: open.options.slice(0, 20).map(o => o.text).join(' | ') || '（没有选项）' })
    await close()
    if (typed) await clearQuery(d, f)
    return { ...fail(typed ? 'search-click' : 'custom-select', 'no_matching_option'), learned, seen: open.options.slice(0, 20).map(o => o.text) }
  }
  let pick = await page.evaluate(pickOptionScript, { selector: f.selector, optId: opt.id, text: opt.text })
  let chosen = opt.text
  // 级联：逐级点
  for (let level = 1; pick.ok && pick.next?.length && level < 5; level++) {
    const seg = segments[level]
    const next = seg ? pickByText(pick.next, seg, f.label) : undefined
    if (!next) { await close(); return { ...fail('cascade', 'no_matching_option', pick.display), learned } }
    pick = await page.evaluate(pickOptionScript, { selector: f.selector, optId: next.id, text: next.text })
    chosen = `${chosen}/${next.text}`
    strategy = 'cascade-click'
  }
  // 选完确认弹层收起
  if (pick.stillOpen) await close()
  const last = chosen.split('/').pop() ?? chosen
  const ok = (display: string) => displayMatches(display, value, f, last) || (!!display && normKey(display).includes(normKey(last)))
  // 读回：选中值的展示可能晚一拍渲染（远程下拉回填 label），最多等 ~1 秒
  let display = ''
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(i ? 180 : 120)
    display = await readDisplay(page, f)
    if (ok(display)) return { verified: true, strategy, display, chosen, learned }
  }
  // 选了却读不回：留一份选完那一刻的表单项 DOM（回滚之后就看不到选中值是怎么渲染的了）
  await snapshotField(d, f, `picked-${f.label}`)
  if (typed) await clearQuery(d, f)
  return { ...fail(strategy, 'option_not_selected', display), chosen, learned }
}

async function snapshotField(d: FillDeps, f: FormField, name: string): Promise<void> {
  if (!d.recorder) return
  try { d.recorder.dom(name, await d.page.evaluate(domSnippetScript, { selector: f.selector })) } catch (e) {
    d.recorder.trace({ stage: 'field', action: 'snapshot', label: f.label, result: 'fail', detail: classifyError(e).raw.slice(0, 120) })
  }
}

/** 搜索型下拉没选中：把输入框里剩下的搜索词清掉（它不是值，但看起来像），只动这个可编辑的搜索框。 */
async function clearQuery(d: FillDeps, f: FormField): Promise<void> {
  try {
    const probe = await d.page.evaluate(probeTargetScript, { selector: f.selector })
    if (probe.editable) await d.page.fill(f.selector, '')
    await d.page.evaluate(closePopupScript, { selector: f.selector })
  } catch { /* 清不掉由回滚核对显示值 */ }
}

/** 直接输入时要试的日期写法：按 placeholder / 现有值推断的那个在前，记忆里成功过的写法最前，再补常见写法。 */
function dateCandidates(value: string, preferred?: string): Array<{ style: DateStyle; text: string }> {
  const p = parseLooseDate(value)
  if (!p) return []
  const styles: DateStyle[] = p.d ? ['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY.MM.DD', 'YYYY年MM月DD日'] : ['YYYY-MM', 'YYYY/MM', 'YYYY.MM', 'YYYY年MM月']
  const list = styles.map(style => ({ style, text: formatDate(value, style) }))
  const given = list.find(x => x.text === value.trim())
  const pref = preferred ? list.find(x => x.style === preferred) : undefined
  return [...(pref ? [pref] : []), ...(given ? [given] : []), ...list].filter((x, i, arr) => arr.findIndex(y => y.style === x.style) === i)
}

async function fillDate(d: FillDeps, f: FormField, value: string, probe: ProbeResult, sig: string): Promise<Outcome> {
  const p = parseLooseDate(value)
  if (!p || !p.m) return fail('date', 'date_unparseable')
  const known = sig ? d.widgetMemory?.recall(sig) : undefined
  await d.page.evaluate(closePopupScript, { selector: f.selector }).catch(() => {}) // 别的面板先收起
  const cands = dateCandidates(value, known?.dateFormat)
  // 记忆里这类日期框"直接输入从没成功、面板成功过"：跳过输入，直接走面板
  const typable = !!probe.editable && !(known?.dateStrategy === 'panel' && !known.dateFormat)
  const r = await d.page.evaluate(datePickScript, { selector: f.selector, y: p.y, m: p.m, d: p.d, text: cands[0]?.text ?? value, texts: cands.map(c => c.text), typable })
  const display = await readDisplay(d.page, f)
  const style = r.used ? cands.find(c => c.text === r.used)?.style : undefined
  const learned: WidgetPatch = { kind: 'date', dateStrategy: r.strategy === 'none' ? undefined : r.strategy, dateFormat: style }
  if (r.ok && displayMatches(display || r.display, value, f)) return { verified: true, strategy: `date-${r.strategy}`, display: display || r.display, learned }
  const panelFile = r.panelHtml && d.recorder ? d.recorder.dom(`panel-${f.label}`, r.panelHtml) : undefined
  d.recorder?.trace({ stage: 'field', action: 'date', label: f.label, result: 'fail', code: 'date_panel_unsupported', detail: r.detail, ...(panelFile ? { shot: panelFile } : {}) })
  return { ...fail(`date-${r.strategy}`, 'date_panel_unsupported', display || r.display), learned: { kind: 'date' } }
}

async function fillOnce(d: FillDeps, f: FormField, value: string, sig: string): Promise<Outcome> {
  const { page } = d
  let probe = await page.evaluate(probeTargetScript, { selector: f.selector })
  if (!probe.exists) return fail('probe', 'element_missing')
  // 禁用（灰的）：多半是联动（选了学校才能选学院 / 专业），等一会儿；还是灰的就不碰（账号锁定的手机号之类）
  for (let i = 0; probe.disabled && i < 8; i++) {
    await page.waitForTimeout(250)
    probe = await page.evaluate(probeTargetScript, { selector: f.selector })
  }
  if (probe.disabled) return fail('probe', 'field_disabled')
  if (probe.blocked && probe.overlay) {
    const cleared = d.clearBlockers ? await d.clearBlockers() : false
    const again = cleared ? await page.evaluate(probeTargetScript, { selector: f.selector }) : probe
    if (again.blocked && again.overlay) return fail('probe', 'blocked_by_overlay')
  }
  switch (f.type) {
    case 'radio': {
      const opt = matchOption(f.options, value, { label: f.label })
      if (!opt) return fail('radio', 'no_matching_option')
      await page.click(radioOptionSelector(f, opt))
      const cur = (await extractFields(page)).find(x => x.id === f.id)
      return displayMatches(cur?.value, opt, f) ? { verified: true, strategy: 'radio', display: cur?.value, chosen: opt } : fail('radio', 'option_not_selected', cur?.value)
    }
    case 'checkbox': {
      const want = /^(true|1|yes|是)$/i.test(value)
      const before = (await extractFields(page)).find(x => x.id === f.id)
      if ((before?.value === 'true') !== want) await page.click(f.selector)
      const cur = (await extractFields(page)).find(x => x.id === f.id)
      return (cur?.value === 'true') === want ? { verified: true, strategy: 'checkbox', display: cur?.value } : fail('checkbox', 'readback_mismatch', cur?.value)
    }
    case 'richtext': {
      try { await page.fill(f.selector, value) } catch { await page.evaluate(fillValueScript, { selector: f.selector, value, kind: 'richtext' }).catch(() => null) }
      const display = await readDisplay(page, f)
      return displayMatches(display, value, f) ? { verified: true, strategy: 'richtext', display } : fail('richtext', 'readback_mismatch', display)
    }
    default: break
  }
  const widget = !!f.framework && f.framework !== 'native'
  if (isDateLike(f) && f.type !== 'select' && (widget || probe.readonly || probe.inShell)) return fillDate(d, f, value, probe, sig)
  if (f.type === 'select' && !f.custom) {
    // 先在抽取到的选项里找（找不到就别让 selectOption 干等超时）
    const hit = f.options.length ? (f.options.includes(value) ? value : matchOption(f.options, value, { label: f.label })) : value
    if (!hit) return fail('native-select', 'no_matching_option')
    try { await page.selectOption(f.selector, { label: hit }) } catch { return fail('native-select', 'no_matching_option') }
    const display = await readDisplay(page, f)
    return displayMatches(display, value, f) ? { verified: true, strategy: 'native-select', display } : fail('native-select', 'option_not_selected', display)
  }
  if (f.type === 'select' || probe.role === 'combobox' || (probe.readonly && probe.inShell)) return fillCustomSelect(d, f, value, sig)
  return fillText(d, f, value, probe)
}

/** 回滚：可编辑文本框清回原值；自定义控件看显示值是否还是原样。 */
async function rollback(d: FillDeps, f: FormField, before: string): Promise<'restored' | 'failed' | 'none'> {
  const now = await readDisplay(d.page, f)
  if (normKey(now) === normKey(before)) return 'restored'
  try {
    // 自定义下拉选上了别的值：原来是空的就点外壳里的清除图标，再读一次
    if (f.type === 'select' && f.custom && !before.trim()) {
      const r = await d.page.evaluate(clearSelectScript, { selector: f.selector })
      if (r.clicked && !(await readDisplay(d.page, f)).trim()) return 'restored'
    }
  } catch { /* 继续按文本框处理 */ }
  try {
    const probe = await d.page.evaluate(probeTargetScript, { selector: f.selector })
    if (probe.editable && ['text', 'email', 'tel', 'number', 'textarea', 'date'].includes(f.type)) {
      await d.page.fill(f.selector, before)
      if (normKey(await readDisplay(d.page, f)) === normKey(before)) return 'restored'
    }
  } catch { /* 下面按失败 */ }
  return 'failed'
}

export async function fillAndVerify(d: FillDeps, f: FormField, value: string, stage = 'field'): Promise<FieldAttempt> {
  const t0 = Date.now()
  const { page } = d
  const recorder = d.recorder ?? noopRecorder
  const before = await readDisplay(page, f)
  try { await page.evaluate(focusFieldScript, { selector: f.selector, label: f.label, highlight: d.highlight !== false }) } catch { /* 高亮失败不影响 */ }
  d.progress?.(`正在填「${f.label}」`)
  // 资料值自身格式不对时不照抄（邮箱用了逗号、全角符号等）：填进去页面也会报错，读回又"一致"，最容易成假成功
  if (isEmailField(f) && !EMAIL_OK.test(value.trim())) {
    recorder.trace({ stage, field: f.id, label: f.label, result: 'fail', code: 'profile_value_invalid', detail: '资料里的邮箱格式不对' })
    return { verified: false, strategy: 'guard', code: 'profile_value_invalid', reason: reasonText('profile_value_invalid'), rollback: 'none', ms: Date.now() - t0 }
  }
  const heavy = f.type === 'select' || isDateLike(f)
  if (heavy && d.capture) await d.capture(`before-${f.label}`)
  let out: Outcome | undefined
  let rawError: string | undefined
  const sig = heavy ? await widgetSig(d, f) : ''
  for (let attempt = 0; attempt < 2 && !out?.verified; attempt++) {
    try {
      out = await withWatchdog(`填写「${f.label}」`, d.watchdogMs ?? 30_000, () => fillOnce(d, f, value, sig))
    } catch (e) {
      const c = classifyError(e)
      rawError = c.raw
      out = fail('error', c.code)
    }
    // 被遮挡 / 超时：过一遍障碍层再试一次
    if (!out.verified && attempt === 0 && (out.code === 'blocked_by_overlay' || out.code === 'timeout') && d.clearBlockers) {
      const ok = await d.clearBlockers().catch(() => false)
      if (!ok) break
      continue
    }
    break
  }
  // 自学习：这类控件这次怎么成 / 怎么败的，写进站点控件记忆
  if (sig && out?.learned) { try { d.widgetMemory?.learn(sig, out.learned, !!out.verified, out.code) } catch { /* 记忆失败不影响填写 */ } }
  // 结构树没办成、又不是真定论 → 模型接着办（field-agent.ts，face-ga-port 2b）；它给的原因带给学生
  if (out && !out.verified) out = await agentTakeover(d, f, value, out, stage)
  // 视觉层可能误按全选：整页被选中就收起选区
  try { const sel = await page.evaluate(pageSelectionScript, { collapse: true }); if (sel.whole) recorder.trace({ stage, action: 'selection', label: f.label, result: 'fail', code: 'page_selected', detail: `${sel.chars} 字被选中，已收起` }) } catch { /* ignore */ }
  try { await page.evaluate(clearHighlightScript) } catch { /* ignore */ }
  const result: FieldAttempt = { ...(out ?? fail('none', 'fill_error')), ms: Date.now() - t0 }
  if (!result.verified) {
    result.rollback = await rollback(d, f, before)
    const shot = d.capture ? await d.capture(`fail-${f.label}`) : undefined
    let dom: string | undefined
    try { dom = recorder.dom(`fail-${f.label}`, await page.evaluate(domSnippetScript, { selector: f.selector })) } catch { /* ignore */ }
    result.reason = result.rollback === 'failed' ? `${reasonText(result.code)}；${reasonText('rollback_failed')}` : reasonText(result.code)
    recorder.bump(result.code ?? 'fill_error')
    recorder.trace({ stage, action: 'fill', field: f.id, label: f.label, strategy: result.strategy, result: 'fail', code: result.code, value, detail: [rawError, result.display !== undefined ? `显示「${result.display}」` : '', `回滚：${result.rollback}`].filter(Boolean).join(' | '), ms: result.ms, shot: [shot, dom].filter(Boolean).join(',') || undefined })
    d.progress?.(`「${f.label}」没填上：${reasonText(result.code)}，留给你补`)
  } else {
    if (heavy && d.capture) await d.capture(`after-${f.label}`)
    recorder.trace({ stage, action: 'fill', field: f.id, label: f.label, strategy: result.strategy, result: 'ok', value: result.chosen ?? value, detail: result.display !== undefined ? `显示「${result.display}」` : undefined, ms: result.ms })
    if (result.chosen) d.progress?.(`「${f.label}」选择了「${result.chosen}」`)
  }
  return result
}

// ---------------------------------------------------------------------------
// 模型接手（field-agent.ts）：结构树没办成的格子，除真定论外一律交模型接着办，照常按用户可见的值核验。
// ---------------------------------------------------------------------------
/** 真定论：模型也改变不了的事实（资料里的值本身 / 格子被锁 / 标签没认准不敢写 / 别处已写过），不交给模型。 */
const FINAL_CODES: ReadonlySet<string> = new Set(['field_disabled', 'date_unparseable', 'profile_value_invalid', 'duplicate_write', 'label_uncertain'])
/** 模型接手一格的看门狗：AGENT_MAX_STEPS 步 ×（一次模型调用 + 动作）留足余量。 */
const AGENT_WATCHDOG_MS = 120_000

/** 这一格现在的值：单选 / 勾选读抽取到的选中态，其余读用户可见的显示值。 */
async function currentValue(d: FillDeps, f: FormField): Promise<string> {
  if (f.type !== 'radio' && f.type !== 'checkbox') return readDisplay(d.page, f)
  try { return (await extractFields(d.page)).find(x => x.id === f.id)?.value ?? '' } catch (e) { d.log?.(`读「${f.label}」的选中态失败：${classifyError(e).raw.slice(0, 80)}`); return '' }
}
/** 下拉只认同一个意思（不认"包含"），模型点到相近项也不算成功。 */
function agentOk(f: FormField, value: string, display: string): boolean {
  if (!display.trim()) return false
  if (f.type === 'checkbox') return (display === 'true') === /^(true|1|yes|是)$/i.test(value)
  if (f.type === 'select') return sameMeaning(display, value, f.label)
  return displayMatches(display, value, f)
}

async function agentTakeover(d: FillDeps, f: FormField, value: string, out: Outcome, stage: string): Promise<Outcome> {
  const llm = d.llm
  if (!llm || d.semantic === false || f.type === 'file' || FINAL_CODES.has(out.code ?? '')) return out
  const recorder = d.recorder ?? noopRecorder
  const trace = (result: 'ok' | 'fail' | 'info', detail?: string) => recorder.trace({ stage, action: 'agent', field: f.id, label: f.label, result, detail })
  const hint = [reasonText(out.code), out.display ? `当时显示「${out.display}」` : '', out.seen?.length ? `认出的选项：${out.seen.join(' | ')}` : ''].filter(Boolean).join('；')
  const verify = async () => { const display = await currentValue(d, f); return { ok: agentOk(f, value, display), display } }
  // 离开这一格再读：收起弹层、失焦后值还在才算填上（搜索词不算）
  const commit = async () => { await d.page.evaluate(closePopupScript, { selector: f.selector }); return verify() }
  try {
    const r = await withWatchdog(`模型接手「${f.label}」`, AGENT_WATCHDOG_MS, () => agentFill({ page: d.page, llm, snapshot: d.snapshot, trace: step => trace('info', step) }, f, value, { hint }, verify, commit))
    // 模型的原因只进日志（运行记录 + 侧车日志锚点 [apply-agent]），批量测完统一捞出来迭代；学生只看我们写好的那句人话
    trace(r.verified ? 'ok' : 'fail', r.verified ? `显示「${r.display}」（${r.steps} 步）` : r.reason)
    recorder.bump(r.verified ? 'agent_ok' : 'agent_fail')
    d.log?.(`[apply-agent] ${r.verified ? 'ok' : 'fail'} field=${f.label} code=${out.code ?? '-'} steps=${r.steps}${r.verified ? '' : ` reason=${r.reason ?? '-'}`}`)
    if (r.verified) return { verified: true, strategy: 'agent', display: r.display, ...(f.type === 'select' || f.type === 'radio' ? { chosen: r.display } : {}) }
    // 没办成：收起它打开的弹层，免得挡住下一格（2026-10-31 小鹏：学历类型的弹层挡住了专业）
    await d.page.evaluate(closePopupScript, { selector: f.selector }).catch((e: unknown) => d.log?.(`收起「${f.label}」的弹层失败：${classifyError(e).raw.slice(0, 80)}`))
    return { ...out, display: r.display || out.display }
  } catch (e) {
    trace('fail', classifyError(e).raw.slice(0, 200))
    return out
  }
}
