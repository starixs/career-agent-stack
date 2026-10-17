import { extractJson, type LLM } from '@career/core'
import type { PageLike } from './page.js'
import { extractFields, radioOptionSelector, type FormField } from './extract.js'
import { fillValueScript } from './scripts.js'
import {
  activeEditableScript, clearSelectScript, closePopupScript, datePickScript, domSnippetScript, focusFieldScript, clearHighlightScript, openOptionsScript,
  pageSelectionScript, pickOptionScript, probeTargetScript, readDisplayScript, type OptionInfo, type ProbeResult,
} from './widgets.js'
import { classifyError, reasonText, withWatchdog, type FieldReasonCode } from './codes.js'
import { DATE_FIELD_RX, dictFor, matchOption, normalizeByDict, parseLooseDate } from './normalize.js'
import { fuzzyEquals, normKey } from './text.js'
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
  const nd = normKey(d), nv = normKey(value)
  if (nd === nv) return true
  if (chosen && (nd === normKey(chosen) || nd.includes(normKey(chosen)))) return true
  if (f.maxLength && nv.startsWith(nd) && nd.length >= Math.min(f.maxLength, nv.length)) return true
  const dd = d.match(/\d+/g)?.map(Number) ?? [], vd = value.match(/\d+/g)?.map(Number) ?? []
  if (isDateLike(f as FormField) && vd.length >= 2 && dd.length >= 2 && dd[0] === vd[0] && dd[1] === vd[1] && (vd.length < 3 || dd[2] === vd[2])) return true
  if (/手机|电话|phone|mobile|tel/i.test(f.label) && d.replace(/\D/g, '').endsWith(value.replace(/\D/g, '')) && value.replace(/\D/g, '').length >= 7) return true
  if (f.type === 'select' || f.type === 'radio') return !!matchOption([d], value, { label: f.label })
  return false
}

type Outcome = Omit<FieldAttempt, 'ms' | 'rollback' | 'reason'>
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

async function fillCustomSelect(d: FillDeps, f: FormField, value: string): Promise<Outcome> {
  const { page } = d
  const close = () => page.evaluate(closePopupScript, { selector: f.selector }).catch(() => {})
  // 先收起别的字段没关上的弹层，免得把它的选项当成这个字段的
  await close()
  let open = await page.evaluate(openOptionsScript, { selector: f.selector })
  if (!open.opened || (!open.options.length && !open.searchable)) { await close(); return fail('custom-select', 'options_not_found') }
  const segments = value.split(/\s*[/／>＞]\s*/).filter(Boolean)
  const first = segments.length > 1 && open.cascade ? segments[0] : value
  let opt = open.options.length ? pickByText(open.options, first, f.label) : undefined
  let strategy = 'option-click'
  let typed = false
  // 可搜索的下拉（远程搜索 / 长列表）：允许键入关键字过滤，但不按回车，仍然点选项；搜出来的只认同一个意思。
  // 不可搜索（输入框 readonly）的绝不打字
  if (!opt && open.searchable && page.keyboard) {
    if (await typeInto(d, f, first)) {
      typed = true
      await page.waitForTimeout(400)
      open = await page.evaluate(openOptionsScript, { selector: f.selector, reopen: true, waitMs: 3000 })
      opt = pickByText(open.options, first, f.label, true)
      strategy = 'search-click'
    }
  }
  if (!opt && !typed && d.llm && open.options.length) { opt = await llmPickOption(d.llm, f.label, first, open.options); if (opt) strategy = 'llm-option-click' }
  if (!opt) {
    d.recorder?.trace({ stage: 'field', action: 'options', label: f.label, result: 'fail', code: 'no_matching_option', detail: open.options.slice(0, 20).map(o => o.text).join(' | ') || '（没有选项）' })
    await close()
    if (typed) await clearQuery(d, f)
    return fail(typed ? 'search-click' : 'custom-select', 'no_matching_option')
  }
  let pick = await page.evaluate(pickOptionScript, { selector: f.selector, optId: opt.id, text: opt.text })
  let chosen = opt.text
  // 级联：逐级点
  for (let level = 1; pick.ok && pick.next?.length && level < 5; level++) {
    const seg = segments[level]
    const next = seg ? pickByText(pick.next, seg, f.label) : undefined
    if (!next) { await close(); return fail('cascade', 'no_matching_option', pick.display) }
    pick = await page.evaluate(pickOptionScript, { selector: f.selector, optId: next.id, text: next.text })
    chosen = `${chosen}/${next.text}`
    strategy = 'cascade-click'
  }
  if (pick.stillOpen) await close()
  const last = chosen.split('/').pop() ?? chosen
  const ok = (display: string) => displayMatches(display, value, f, last) || (!!display && normKey(display).includes(normKey(last)))
  // 读回：选中值的展示可能晚一拍渲染（远程下拉回填 label），最多等 ~1 秒
  let display = ''
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(i ? 180 : 120)
    display = await readDisplay(page, f)
    if (ok(display)) return { verified: true, strategy, display, chosen }
  }
  if (typed) await clearQuery(d, f)
  return { ...fail(strategy, 'option_not_selected', display), chosen }
}

/** 搜索型下拉没选中：把输入框里剩下的搜索词清掉（它不是值，但看起来像），只动这个可编辑的搜索框。 */
async function clearQuery(d: FillDeps, f: FormField): Promise<void> {
  try {
    const probe = await d.page.evaluate(probeTargetScript, { selector: f.selector })
    if (probe.editable) await d.page.fill(f.selector, '')
    await d.page.evaluate(closePopupScript, { selector: f.selector })
  } catch { /* 清不掉由回滚核对显示值 */ }
}

async function fillDate(d: FillDeps, f: FormField, value: string, probe: ProbeResult): Promise<Outcome> {
  const p = parseLooseDate(value)
  if (!p || !p.m) return fail('date', 'date_unparseable')
  await d.page.evaluate(closePopupScript, { selector: f.selector }).catch(() => {}) // 别的面板先收起
  const r = await d.page.evaluate(datePickScript, { selector: f.selector, y: p.y, m: p.m, d: p.d, text: value, typable: !!probe.editable })
  const display = await readDisplay(d.page, f)
  if (r.ok && displayMatches(display || r.display, value, f)) return { verified: true, strategy: `date-${r.strategy}`, display: display || r.display }
  d.recorder?.trace({ stage: 'field', action: 'date', label: f.label, result: 'fail', code: 'date_panel_unsupported', detail: r.detail })
  return fail(`date-${r.strategy}`, 'date_panel_unsupported', display || r.display)
}

async function fillOnce(d: FillDeps, f: FormField, value: string): Promise<Outcome> {
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
  if (isDateLike(f) && f.type !== 'select' && (widget || probe.readonly || probe.inShell)) return fillDate(d, f, value, probe)
  if (f.type === 'select' && !f.custom) {
    try { await page.selectOption(f.selector, { label: value }) } catch {
      const hit = matchOption(f.options, value, { label: f.label })
      if (!hit) return fail('native-select', 'no_matching_option')
      await page.selectOption(f.selector, { label: hit })
    }
    const display = await readDisplay(page, f)
    return displayMatches(display, value, f) ? { verified: true, strategy: 'native-select', display } : fail('native-select', 'option_not_selected', display)
  }
  if (f.type === 'select' || probe.role === 'combobox' || (probe.readonly && probe.inShell)) return fillCustomSelect(d, f, value)
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
  for (let attempt = 0; attempt < 2 && !out?.verified; attempt++) {
    try {
      out = await withWatchdog(`填写「${f.label}」`, d.watchdogMs ?? 30_000, () => fillOnce(d, f, value))
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
