import { extractJson, type LLM } from '@career/core'
import type { PageLike } from './page.js'
import { extractFields, radioOptionSelector, type FormField } from './extract.js'
import { fillValueScript } from './scripts.js'
import {
  activeEditableScript, clearSelectScript, closePopupScript, datePickScript, domSnippetScript, focusFieldScript, clearHighlightScript, openOptionsScript,
  pageSelectionScript, pickOptionScript, probeTargetScript, readDisplayScript, semanticContextScript, widgetSignatureScript, type OptionInfo, type ProbeResult,
} from './widgets.js'
import { classifyError, reasonText, withWatchdog, type FieldReasonCode } from './codes.js'
import type { BoundWidgetMemory, WidgetPatch } from './memory.js'
import { formatDate, type DateStyle } from './normalize.js'
import { isNextText, isSubmitText } from './guards.js'
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
  /** 语义兜底层（启发式都失败时让模型在受限动作集里走一步）；默认开，没有 llm 时不跑。 */
  semantic?: boolean
  /** 给语义兜底层的打码截图（模型支持图片时附上）。 */
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
type Outcome = Omit<FieldAttempt, 'ms' | 'rollback' | 'reason'> & { learned?: WidgetPatch }
const fail = (strategy: string, code: FieldReasonCode, display?: string): Outcome => ({ verified: false, strategy, code, display })

async function readDisplay(page: PageLike, f: FormField): Promise<string> {
  try { return (await page.evaluate(readDisplayScript, { selector: f.selector })).display } catch { return '' }
}

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
  if (!open.opened || (!open.options.length && !editable)) { await close(); return { ...fail('custom-select', 'options_not_found'), learned } }
  const segments = value.split(/\s*[/／>＞]\s*/).filter(Boolean)
  const first = segments.length > 1 && open.cascade ? segments[0] : value
  let opt = open.options.length ? pickByText(open.options, first, f.label) : undefined
  let strategy = 'option-click'
  let typed = false
  // 可搜索探测（行为，不看类名）：先键入一两个字，看候选 / 弹层文字有没有变化；没变化 → 不可搜索，清空、不再打字。
  // 不可编辑（readonly）的输入框一个字都不打。搜出来的结果只认同一个意思，不按回车，仍然点选项
  if (!opt && editable && page.keyboard) {
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
  if (!opt && !typed && d.llm && open.options.length) { opt = await llmPickOption(d.llm, f.label, first, open.options); if (opt) strategy = 'llm-option-click' }
  if (!opt) {
    d.recorder?.trace({ stage: 'field', action: 'options', label: f.label, result: 'fail', code: 'no_matching_option', detail: open.options.slice(0, 20).map(o => o.text).join(' | ') || '（没有选项）' })
    await close()
    if (typed) await clearQuery(d, f)
    return { ...fail(typed ? 'search-click' : 'custom-select', 'no_matching_option'), learned }
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
  if (typed) await clearQuery(d, f)
  return { ...fail(strategy, 'option_not_selected', display), chosen, learned }
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
  d.recorder?.trace({ stage: 'field', action: 'date', label: f.label, result: 'fail', code: 'date_panel_unsupported', detail: r.detail })
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
  // 语义兜底：下拉 / 日期的启发式都没成（不是"选项里没有"这种确定结论）→ 让模型在受限动作集里走几步，照常按可见值核验
  if (out && !out.verified && d.llm && d.semantic !== false && SEMANTIC_CODES.has(out.code ?? '') && (f.type === 'select' || isDateLike(f))) {
    try {
      const sem = await withWatchdog(`语义兜底「${f.label}」`, d.watchdogMs ?? 30_000, () => semanticFill(d, f, value))
      if (sem.verified) out = sem
      recorder.trace({ stage, action: 'semantic', field: f.id, label: f.label, result: sem.verified ? 'ok' : 'fail', detail: sem.display !== undefined ? `显示「${sem.display}」` : sem.strategy })
    } catch (e) { recorder.trace({ stage, action: 'semantic', field: f.id, label: f.label, result: 'fail', detail: classifyError(e).raw.slice(0, 200) }) }
  }
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
// 语义兜底层：字段所在表单项 + 附近浮层的精简节点表（打码）+ 可选的打码截图 → 模型在受限动作集里给一步：
//   click(ref) / type(ref, text) / done / give_up。确定性约束：
//   - 只能点表单项或其浮层里的节点，文案像提交 / 下一步的节点不点；
//   - 只能往可编辑、焦点确认在它上面的输入框里打字，且打的字必须是资料值的一部分（不让模型编值）；
//   - 最多 4 步，每步后按用户可见显示值核验，过了才算成功；不过由 fillAndVerify 照常回滚留空。
// ---------------------------------------------------------------------------
const SEMANTIC_CODES = new Set(['options_not_found', 'option_not_selected', 'date_panel_unsupported', 'readback_mismatch', 'not_editable'])
interface SemanticStep { action?: 'click' | 'type' | 'done' | 'give_up'; ref?: string; text?: string }
async function semanticFill(d: FillDeps, f: FormField, value: string): Promise<Outcome> {
  const { page, llm } = d
  if (!llm) return fail('semantic', 'fill_error')
  const history: string[] = []
  // 下拉只认同一个意思（不认"包含"）：模型点到相近项也不算成功
  const semanticOk = (disp: string) => !!disp && (f.type === 'select' ? sameMeaning(disp, value, f.label) : displayMatches(disp, value, f))
  const system = '你在帮用户操作网页表单里的一个控件（下拉 / 日期 / 自定义组件），把它设成给定的值。你只能从给出的节点里选一步动作，输出 JSON：' +
    '{"action":"click","ref":"r3"} 或 {"action":"type","ref":"r1","text":"要输入的字"} 或 {"action":"done"} 或 {"action":"give_up"}。' +
    '规则：只为把这个控件设成目标值；不点提交 / 下一步 / 保存 / 删除；输入的字只能取自目标值；看不到确定对应目标值的选项就 give_up，绝不选相近的。'
  for (let step = 0; step < 4; step++) {
    const ctx = await page.evaluate(semanticContextScript, { selector: f.selector })
    if (!ctx.nodes.length) break
    const display = await readDisplay(page, f)
    if (step > 0 && semanticOk(display)) return { verified: true, strategy: 'semantic', display }
    const lines = ctx.nodes.map(n => `${n.ref} <${n.tag}${n.role ? ` role=${n.role}` : ''}${n.editable ? ' 可输入' : ''}${n.inPopup ? ' 浮层' : ''}> ${n.text}`).join('\n')
    let images: Array<{ mediaType: 'image/jpeg'; data: string }> | undefined
    if (llm.supportsImages?.() && d.snapshot) { try { const shot = await d.snapshot(); if (shot) images = [{ mediaType: 'image/jpeg', data: Buffer.from(shot).toString('base64') }] } catch { /* 没图也行 */ } }
    const res = await llm.complete({ system, messages: [{ role: 'user', content: `字段：${f.label}\n目标值：${value}\n当前显示：${display || '（空）'}\n已做：${history.join('；') || '无'}\n可操作节点：\n${lines}`, ...(images ? { images } : {}) }], json: true, temperature: 0, maxTokens: 120 })
    const a = extractJson<SemanticStep>(res.text)
    if (a.action === 'done' || a.action === 'give_up' || !a.action) break
    const node = ctx.nodes.find(n => n.ref === a.ref)
    if (!node) break
    const sel = `[data-career-ref="${node.ref}"]`
    if (a.action === 'click') {
      if (isSubmitText(node.text) || isNextText(node.text) || /保存|删除|取消|提交|投递|确定提交/.test(node.text)) break
      await page.click(sel)
      history.push(`点了 ${node.ref}「${node.text}」`)
    } else if (a.action === 'type') {
      const text = (a.text ?? '').trim()
      // 只允许输入目标值的一部分；只往可编辑、焦点确认在它上面的框里打
      if (!text || !normKey(value).includes(normKey(text)) || !node.editable || !page.keyboard) break
      await page.click(sel)
      const focus = await page.evaluate(activeEditableScript, { selector: sel }).catch(() => null)
      if (!focus?.editable || !focus.isTarget) break
      for (const ch of Array.from(text)) await page.keyboard.type(ch)
      history.push(`在 ${node.ref} 输入「${text}」`)
    } else break
    await page.waitForTimeout(400)
  }
  const display = await readDisplay(page, f)
  return semanticOk(display) ? { verified: true, strategy: 'semantic', display } : fail('semantic', 'option_not_selected', display)
}
