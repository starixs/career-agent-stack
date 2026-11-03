import { extractJson, type LLM } from '@career/core'
import { classifyError } from './codes.js'
import type { FormField } from './extract.js'
import { isNextText, isSubmitText } from './guards.js'
import type { PageLike } from './page.js'
import type { PageScript } from './scripts.js'
import { normKey } from './text.js'
import { activeEditableScript, semanticContextScript, type SemanticNode } from './widgets.js'

/**
 * 字段兜底代理：结构树没办成、又不是真定论的格子，交给模型接着办（face-ga-port 2b，2026-10-31 你定）。
 *  - 结构树先走（快、准）；它的结论只是给模型的线索，不是判决。真定论（资料里没有值 / 格子是灰的 / 值格式不对 / 安全拦截）由调用方先挡掉。
 *  - 错误即观察：每一步动作没成（被挡、超时、元素没了）只写进工作记忆，下一步换方式，绝不抛出中断。
 *  - 不把模型捆死：表单项 + 浮层节点 + 当前显示 + 结构层发现都给它，能点、打字、按键、滚动，步数给够。
 *  - 每一步之后由调用方按用户可见的值核验，过了才算成；模型也办不成才交给人。它说的原因只进日志（批量测完统一迭代），不给学生看。
 * 循环思路同 GenericAgent（https://github.com/lsdefine/GenericAgent ，MIT）：观察 → 一步动作 → 回执进工作记忆，原地打转提醒换路。
 */

/** 一格最多走几步：点开 → 搜 / 滚 → 选 → 收起，通常三四步；留出换方式重试的余量。 */
export const AGENT_MAX_STEPS = 8
/** 连续几步页面毫无变化就停：再走只是花时间。 */
const AGENT_STALL_STOP = 4
/** 提醒换路的门槛。 */
const AGENT_STALL_WARN = 2
/** 动作后等页面反应的时间（下拉展开 / 选中回显）。 */
const SETTLE_MS = 350
const MAX_NOTE = 120
const KEYS: ReadonlySet<string> = new Set(['Enter', 'ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Backspace', 'PageDown', 'PageUp'])
const DANGER_RX = /保存|删除|取消|提交|投递|确定提交|退出|注销/

export interface AgentGoal {
  /** 结构层留下的线索：它做到哪一步、为什么没成、看到了哪些选项。 */
  hint?: string
}
export interface AgentDeps {
  page: PageLike
  llm: LLM
  /** 模型支持图片时附上的打码截图。 */
  snapshot?: () => Promise<Uint8Array | undefined>
  maxSteps?: number
  trace?: (step: string) => void
}
/** 调用方的核验：按用户可见的值判断这一格现在是不是目标值。 */
export type AgentVerify = () => Promise<{ ok: boolean; display: string }>
export interface AgentResult { verified: boolean; display: string; steps: number; reason?: string }

interface Decision { note?: unknown; action?: unknown; ref?: unknown; text?: unknown; key?: unknown; direction?: unknown; reason?: unknown }
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

// ---------------------------------------------------------------------------
// 页内动作（都不抛错：拿不到元素返回 ok:false，由循环记成观察）
// ---------------------------------------------------------------------------
interface PointResult { ok: boolean; x: number; y: number; hittable: boolean; cover?: string }
/** 把节点滚进视口，给出它露出来的中心点，并判断那一点最上层是不是它自己（没被浮层 / 遮罩挡住）。 */
export const agentPointScript: PageScript<{ selector: string }, PointResult> = {
  id: 'career.agentPoint',
  fn: ({ selector }) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return { ok: false, x: 0, y: 0, hittable: false }
    let r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) { try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch { /* 滚不动就按原位置判断 */ } r = el.getBoundingClientRect() }
    if (r.width < 1 || r.height < 1) return { ok: false, x: 0, y: 0, hittable: false }
    const x = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1)
    const y = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
    const top = document.elementFromPoint(x, y)
    const hittable = !!top && (top === el || el.contains(top) || top.contains(el))
    const cover = hittable || !top ? undefined : `${top.tagName.toLowerCase()}.${(typeof top.className === 'string' ? top.className : '').split(/\s+/)[0] ?? ''}`
    return { ok: true, x, y, hittable, cover }
  },
}
/** 直接在节点上派发一整套指针 / 鼠标事件（被挡住时用；框架的冒泡处理照样收得到）。 */
export const agentDispatchClickScript: PageScript<{ selector: string }, boolean> = {
  id: 'career.agentDispatchClick',
  fn: ({ selector }) => {
    const n = document.querySelector(selector)
    if (!n) return false
    if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
    n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
    n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return true
  },
}
/** 滚动节点所在的列表：先找能滚的祖先改 scrollTop，同时派发滚轮事件（虚拟列表靠滚轮事件翻页）。 */
export const agentScrollScript: PageScript<{ selector: string; down: boolean }, { ok: boolean; moved: boolean }> = {
  id: 'career.agentScroll',
  fn: ({ selector, down }) => {
    const el = document.querySelector(selector)
    if (!el) return { ok: false, moved: false }
    let box: Element | null = el
    while (box && !(box.scrollHeight > box.clientHeight + 4 && box.clientHeight > 0)) box = box.parentElement
    const target = box ?? el
    const before = target.scrollTop
    const delta = (down ? 1 : -1) * Math.max(80, Math.round(target.clientHeight * 0.8))
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }))
    target.scrollTop = before + delta
    return { ok: true, moved: target.scrollTop !== before }
  },
}

/** 点一下，点不到就换方式：真实鼠标点露出来的中心 → 被挡就直接派发事件 → 最后才用带可操作性等待的点击。返回回执。 */
export async function robustClick(page: PageLike, selector: string): Promise<string> {
  const pt = await page.evaluate(agentPointScript, { selector }).catch((e: unknown) => ({ ok: false, x: 0, y: 0, hittable: false, cover: classifyError(e).text }))
  if (pt.ok && pt.hittable && page.mouse) {
    try { await page.mouse.click(pt.x, pt.y); return '点到了' } catch (e) { return `${await dispatchClick(page, selector, classifyError(e).text)}` }
  }
  if (pt.ok) return dispatchClick(page, selector, pt.cover ? `被「${pt.cover}」挡住` : '')
  try { await page.click(selector); return '点到了' } catch (e) { return `没点成：${classifyError(e).text}` }
}
async function dispatchClick(page: PageLike, selector: string, why: string): Promise<string> {
  try {
    const ok = await page.evaluate(agentDispatchClickScript, { selector })
    return ok ? `${why ? `${why}，` : ''}改为直接派发点击` : '这个节点不见了'
  } catch (e) { return `没点成：${classifyError(e).text}` }
}

/** 打的字只能来自目标值（不让模型编值）：目标值的一部分，或同一个日期的另一种写法。 */
export function typedFromValue(text: string, value: string): boolean {
  const t = normKey(text)
  if (!t) return false
  if (normKey(value).includes(t)) return true
  const digits = (s: string) => s.replace(/\D/g, '')
  return /^[\d\s年月日./\-]+$/.test(text) && digits(text).length >= 2 && digits(value).includes(digits(text))
}

// ---------------------------------------------------------------------------
// 循环
// ---------------------------------------------------------------------------
const SYSTEM = [
  '你在替一名应届生填网申表里的一格：把它设成目标值，并且让页面上真的显示出来。',
  '你看到的是这一格所在的表单项、它弹出来的浮层里的节点（每个节点有编号）。一次只做一步，做完会告诉你结果和当前显示。',
  '动作（只输出一个 JSON 对象）：',
  '{"note":"一句话：看到了什么、为什么这么做","action":"click","ref":"r3"}',
  '{"note":"…","action":"type","ref":"r1","text":"要输入的字"}  （只能打目标值或它的一部分，用来输入或搜索）',
  '{"note":"…","action":"key","key":"ArrowDown"}  （可用：ArrowDown / ArrowUp / Enter / Escape / Tab / Backspace / PageDown / PageUp）',
  '{"note":"…","action":"scroll","ref":"r5","direction":"down"}  （选项没露出来时滚动列表）',
  '{"note":"…","action":"done"}  （页面上已经显示目标值）',
  '{"note":"…","action":"give_up","reason":"为什么办不到（写进开发日志，不给学生看）"}  （确定办不到）',
  '规则：1. 只为把这一格设成目标值；不点提交 / 下一步 / 保存 / 删除。',
  '2. 下拉 / 单选只选和目标值意思相同的项（「硕士」=「硕士研究生」、「统招全日制」≈「全日制统招」）；先在列表里找，没露出来就搜索或滚动，确实没有再 give_up，绝不选相近但不同的。',
  '3. 上一步没成（被挡住、没反应、当前显示没变）就换方式：点旁边的箭头或外层、用键盘、先滚动、先点开再选。',
  '4. 结构层的发现只是线索，可能看错（例如把整个列表当成了一项），以你看到的节点为准。',
].join('\n')

interface Memory { history: string[]; stall: number; lastSig: string }

function describeNodes(nodes: SemanticNode[]): string {
  return nodes.map(n => `${n.ref} <${n.tag}${n.role ? ` role=${n.role}` : ''}${n.editable === true ? ' 可输入' : n.editable === false ? ' 只读' : ''}${n.inPopup ? ' 浮层' : ''}> ${n.text}`).join('\n')
}

function turnPrompt(f: FormField, value: string, goal: AgentGoal, display: string, nodes: SemanticNode[], mem: Memory, step: number, max: number): string {
  const kind = f.type === 'select' ? '下拉' : f.type === 'radio' ? '单选' : f.type === 'checkbox' ? '勾选框' : f.type === 'date' ? '日期' : '输入框'
  const stall = mem.stall >= AGENT_STALL_WARN ? `\n[注意] 已经连续 ${mem.stall} 步页面没有变化：换一种方式。` : ''
  return `字段：${f.label}（${kind}）\n目标值：${value}\n当前显示：${display || '（空）'}\n结构层的发现：${goal.hint || '无'}\n已做：${mem.history.length ? `\n${mem.history.join('\n')}` : '无'}${stall}\n\n第 ${step} / ${max} 步。可操作节点：\n${describeNodes(nodes)}`
}

async function decide(d: AgentDeps, prompt: string): Promise<Decision | null> {
  try {
    let images: Array<{ mediaType: 'image/jpeg'; data: string }> | undefined
    if (d.llm.supportsImages?.() && d.snapshot) { const shot = await d.snapshot().catch(() => undefined); if (shot) images = [{ mediaType: 'image/jpeg', data: Buffer.from(shot).toString('base64') }] }
    const res = await d.llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: prompt, ...(images ? { images } : {}) }], json: true, temperature: 0, maxTokens: 400 })
    return extractJson<Decision>(res.text)
  } catch (e) {
    d.trace?.(`模型这一步没给出可用的决定：${classifyError(e).raw.slice(0, 120)}`)
    return null
  }
}

/** 执行一步；返回回执（给工作记忆），null 表示动作被规则拦下没执行。 */
async function act(page: PageLike, a: Decision, node: SemanticNode | undefined, value: string): Promise<string | null> {
  const action = str(a.action)
  const sel = node ? `[data-career-ref="${node.ref}"]` : ''
  if (action === 'click') {
    if (!node || isSubmitText(node.text) || isNextText(node.text) || DANGER_RX.test(node.text)) return null
    return robustClick(page, sel)
  }
  if (action === 'type') {
    const text = str(a.text)
    if (!node || node.editable !== true || !typedFromValue(text, value) || !page.keyboard) return null
    const clicked = await robustClick(page, sel)
    const focus = await page.evaluate(activeEditableScript, { selector: sel }).catch(() => null)
    if (!focus?.editable || !focus.isTarget) return `${clicked}，但光标没落在这个框里，没打字`
    try { for (const ch of Array.from(text)) await page.keyboard.type(ch) } catch (e) { return `打字没成：${classifyError(e).text}` }
    return `打了「${text}」`
  }
  if (action === 'key') {
    const key = str(a.key)
    if (!KEYS.has(key) || !page.keyboard) return null
    try { await page.keyboard.press(key); return `按了 ${key}` } catch (e) { return `按键没成：${classifyError(e).text}` }
  }
  if (action === 'scroll') {
    if (!node) return null
    const r = await page.evaluate(agentScrollScript, { selector: sel, down: str(a.direction) !== 'up' }).catch(() => ({ ok: false, moved: false }))
    return r.ok ? (r.moved ? '列表滚动了' : '列表没有再滚动（可能到头了，或是虚拟列表）') : '这个节点不见了'
  }
  return null
}

/**
 * 看着填上了，再离开这一格读一次（commit：收起弹层、失焦后读）：搜索型下拉里只打了字、没点选项时，
 * 输入框里的搜索词会被当成显示值，离开后就没了（2026-10-31 小鹏「学校名称」）。没给 commit 就以 verify 为准。
 */
async function settled(commit: AgentVerify | undefined, check: { ok: boolean; display: string }): Promise<{ ok: boolean; display: string }> {
  return commit ? commit().catch(() => ({ ok: false, display: '' })) : check
}
const NOT_COMMITTED = (n: number, display: string) => `${n}. 看着填上了，但离开这一格后显示「${display || '空'}」：刚才只是搜索词，要点选下拉里的选项`

/** 走一趟。永不抛错：读页面失败、模型失败、动作失败都折算成观察或「没办成」。 */
export async function agentFill(d: AgentDeps, f: FormField, value: string, goal: AgentGoal, verify: AgentVerify, commit?: AgentVerify): Promise<AgentResult> {
  const max = d.maxSteps ?? AGENT_MAX_STEPS
  const mem: Memory = { history: [], stall: 0, lastSig: '' }
  let display = ''
  for (let step = 1; step <= max; step++) {
    const ctx = await d.page.evaluate(semanticContextScript, { selector: f.selector }).catch(() => ({ nodes: [] as SemanticNode[] }))
    const check = await verify().catch(() => ({ ok: false, display: '' }))
    display = check.display
    if (step > 1 && check.ok) {
      const done = await settled(commit, check)
      if (done.ok) return { verified: true, display: done.display, steps: step - 1 }
      mem.history.push(NOT_COMMITTED(step - 1, done.display)); continue
    }
    if (!ctx.nodes.length) return { verified: false, display, steps: step - 1, reason: '这一格在页面上找不到可操作的地方了' }
    const sig = `${display}#${ctx.nodes.map(n => n.text).join('|')}`
    mem.stall = step > 1 && sig === mem.lastSig ? mem.stall + 1 : 0
    mem.lastSig = sig
    if (mem.stall >= AGENT_STALL_STOP) return { verified: false, display, steps: step - 1, reason: '换了几种方式，页面都没有反应' }
    const a = await decide(d, turnPrompt(f, value, goal, display, ctx.nodes, mem, step, max))
    const action = str(a?.action)
    const note = clip(str(a?.note), MAX_NOTE)
    if (!a || !action) { mem.history.push(`${step}. （模型没给出动作）`); mem.stall++; continue }
    if (action === 'give_up') return { verified: false, display, steps: step, reason: clip(str(a.reason) || note || '模型判断办不到', MAX_NOTE) }
    if (action === 'done') {
      const done = check.ok ? await settled(commit, check) : check
      if (done.ok) return { verified: true, display: done.display, steps: step }
      mem.history.push(check.ok ? NOT_COMMITTED(step, done.display) : `${step}. 说做完了，但当前显示「${display || '空'}」还不是目标值`); continue
    }
    const node = ctx.nodes.find(n => n.ref === str(a.ref))
    const receipt = await act(d.page, a, node, value)
    mem.history.push(`${step}. ${note} → ${action}${node ? ` ${node.ref}「${clip(node.text, 20)}」` : ''}：${receipt ?? '不合规则，没执行'}`)
    d.trace?.(mem.history[mem.history.length - 1])
    await d.page.waitForTimeout(SETTLE_MS)
  }
  const last = await verify().catch(() => ({ ok: false, display }))
  const final = last.ok ? await settled(commit, last) : last
  return final.ok ? { verified: true, display: final.display, steps: max } : { verified: false, display: final.display, steps: max, reason: `走了 ${max} 步还没设成「${clip(value, 20)}」` }
}
