/**
 * 第二批页内脚本：障碍扫描、目标探测、画面跟随高亮、自定义下拉"点开 → 枚举 → 点选 → 读回"、
 * 日期面板按年 → 月（→ 日）导航、焦点 / 选区检查、遥测截图前的敏感框模糊。
 *
 * 和 scripts.ts 一样：每个脚本带稳定 id，fn 必须自包含（会被序列化进页面），FakePage 按 id 用内存模型回答。
 * 这些脚本只读 / 只点选项，永远不碰提交按钮；写值只发生在"可编辑的普通文本框"（日期框可输入时）上。
 */
import type { PageScript } from './scripts.js'

export const WIDGET_SCRIPT_IDS = {
  focusField: 'career.focusField',
  clearHighlight: 'career.clearHighlight',
  probeTarget: 'career.probeTarget',
  scanDialogs: 'career.scanDialogs',
  openOptions: 'career.openOptions',
  pickOption: 'career.pickOption',
  closePopup: 'career.closePopup',
  readDisplay: 'career.readDisplay',
  datePick: 'career.datePick',
  activeEditable: 'career.activeEditable',
  pageSelection: 'career.pageSelection',
  prepareEntryClick: 'career.prepareEntryClick',
  maskSensitive: 'career.maskSensitive',
  libraryFingerprint: 'career.libraryFingerprint',
  formStats: 'career.formStats',
  domSnippet: 'career.domSnippet',
} as const

// ---------------------------------------------------------------------------
// 画面跟随：滚到正中 + 独立 shadow root 的高亮框（pointer-events:none，不影响点击命中与站点脚本）
// ---------------------------------------------------------------------------
export interface FocusFieldArg { selector: string; label?: string; highlight?: boolean }
export interface FocusFieldResult { ok: boolean; x?: number; y?: number; w?: number; h?: number }
export const focusFieldScript: PageScript<FocusFieldArg, FocusFieldResult> = {
  id: WIDGET_SCRIPT_IDS.focusField,
  fn: ({ selector, label, highlight }) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return { ok: false }
    let box: Element = el
    const r0 = el.getBoundingClientRect()
    if (r0.width < 4 || r0.height < 4) { const p = el.closest('[class*="select" i], [class*="picker" i], [class*="upload" i], [class*="form-item" i]'); if (p) box = p }
    try { box.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior }) } catch { box.scrollIntoView() }
    const r = box.getBoundingClientRect()
    if (highlight !== false) {
      const w = window as unknown as { __careerHl?: ShadowRoot }
      let root = w.__careerHl
      if (!root || !root.host.isConnected) {
        const host = document.createElement('div')
        host.setAttribute('data-career-overlay', '1')
        host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647'
        document.documentElement.appendChild(host)
        root = host.attachShadow({ mode: 'closed' })
        root.innerHTML = '<style>.b{position:fixed;border:2px solid #2f7cf6;border-radius:6px;box-shadow:0 0 0 4px rgba(47,124,246,.18);pointer-events:none}.t{position:fixed;background:#2f7cf6;color:#fff;font:12px/20px -apple-system,"PingFang SC",sans-serif;padding:0 8px;border-radius:4px;pointer-events:none;white-space:nowrap}</style><div class="b"></div><div class="t"></div>'
        w.__careerHl = root
      }
      const b = root.querySelector('.b') as HTMLElement, t = root.querySelector('.t') as HTMLElement
      Object.assign(b.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px`, display: 'block' })
      t.textContent = label ? `正在填「${label.slice(0, 20)}」` : '正在填写'
      Object.assign(t.style, { left: `${Math.max(0, r.left - 4)}px`, top: `${Math.max(0, r.top - 28)}px`, display: 'block' })
    }
    return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
  },
}
export const clearHighlightScript: PageScript<void, boolean> = {
  id: WIDGET_SCRIPT_IDS.clearHighlight,
  fn: () => {
    const w = window as unknown as { __careerHl?: ShadowRoot }
    const root = w.__careerHl
    if (root?.host.isConnected) root.host.remove()
    w.__careerHl = undefined
    return true
  },
}

// ---------------------------------------------------------------------------
// 目标探测：存在 / 可编辑 / 只读 / 自定义外壳 / 中心点是否被别的元素（弹窗、遮罩、吸顶栏）挡住
// ---------------------------------------------------------------------------
export interface ProbeResult {
  exists: boolean
  visible?: boolean
  editable?: boolean
  readonly?: boolean
  disabled?: boolean
  tag?: string
  inputType?: string
  role?: string
  inShell?: boolean
  blocked?: boolean
  /** 挡住它的是弹窗 / 遮罩 / 浮层（需要障碍层处理），而不是普通吸顶栏。 */
  overlay?: boolean
  blocker?: { tag: string; cls: string; text: string }
}
export const probeTargetScript: PageScript<{ selector: string }, ProbeResult> = {
  id: WIDGET_SCRIPT_IDS.probeTarget,
  fn: ({ selector }) => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return { exists: false }
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const tag = el.tagName.toLowerCase()
    const input = el as HTMLInputElement
    const type = (input.type || '').toLowerCase()
    const role = el.getAttribute('role') || ''
    const readonly = !!input.readOnly || el.hasAttribute('readonly')
    const disabled = !!input.disabled || el.getAttribute('aria-disabled') === 'true'
    const SHELL = '.ant-select, .ant-picker, .ant-cascader, .el-select, .el-date-editor, .el-cascader, .ivu-select, .ivu-date-picker, .mtd-select, .mtd-picker, .mtd-date-picker, .mtd-cascader, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, [class*="select" i], [class*="picker" i], [class*="cascader" i]'
    const shell = el.parentElement ? el.parentElement.closest(SHELL) : null
    const textLike = (tag === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'image', 'reset', 'hidden', 'range', 'color'].includes(type)) || tag === 'textarea' || el.isContentEditable
    const editable = textLike && !readonly && !disabled && role !== 'combobox'
    let target: Element = el
    let r = el.getBoundingClientRect()
    if ((r.width < 4 || r.height < 4) && shell) { target = shell; r = shell.getBoundingClientRect() }
    const visible = r.width >= 2 && r.height >= 2
    let blocked = false, overlay = false
    let blocker: ProbeResult['blocker']
    if (visible) {
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1)
      const cy = Math.min(Math.max(r.top + Math.min(r.height / 2, 20), 1), window.innerHeight - 1)
      const top = document.elementFromPoint(cx, cy)
      const wrap = el.closest('[class*="form-item" i], [class*="form-group" i], label, [class*="field" i]')
      const related = !top || top === document.body || top === document.documentElement || top === el || el.contains(top) || top === target || target.contains(top) || (!!shell && shell.contains(top)) || (!!wrap && wrap.contains(top) && !top.closest('[role=dialog], [class*="modal" i], [class*="mask" i]'))
      if (!related && top) {
        blocked = true
        const ov = top.closest('[role=dialog], [role=alertdialog], [aria-modal="true"], [class*="modal" i], [class*="mask" i], [class*="dialog" i], [class*="overlay" i], [class*="popup" i], [class*="drawer" i], [class*="popover" i], [class*="cookie" i], [class*="consent" i]')
        let fixedAnc = false
        for (let n: Element | null = top, i = 0; n && i < 8; n = n.parentElement, i++) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') { fixedAnc = true; break } }
        overlay = !!ov
        const src = (ov || top) as HTMLElement
        blocker = { tag: src.tagName.toLowerCase(), cls: (typeof src.className === 'string' ? src.className : '').slice(0, 120), text: clean(src.innerText || src.textContent).slice(0, 120) }
        if (!ov && !fixedAnc) blocked = false // 普通文档流元素重叠（多为抽取误差），不当作遮挡
      }
    }
    return { exists: true, visible, editable, readonly, disabled, tag, inputType: type || undefined, role: role || undefined, inShell: !!shell, blocked, overlay, blocker }
  },
}

// ---------------------------------------------------------------------------
// 障碍扫描：可见的模态 / 对话框 / cookie 横幅，带文本与按钮（打 data-career-dlg-btn 标记）
// ---------------------------------------------------------------------------
export interface DialogButton { id: string; text: string; selector: string }
export interface DialogInfo { id: string; text: string; buttons: DialogButton[]; modal: boolean; kind: 'cookie' | 'dialog' }
export interface DialogScan { dialogs: DialogInfo[]; mask: boolean }
export const scanDialogsScript: PageScript<void, DialogScan> = {
  id: WIDGET_SCRIPT_IDS.scanDialogs,
  fn: () => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const vw = window.innerWidth, vh = window.innerHeight
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width < 30 || r.height < 16 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || '1') > 0.05
    }
    const SEL = '[role=dialog], [role=alertdialog], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="popup" i], [class*="drawer" i], [class*="cookie" i], [id*="cookie" i], [class*="consent" i]'
    const EXCLUDE = '[class*="select-dropdown" i], [class*="select-popup" i], [class*="picker" i], [class*="cascader" i], [class*="dropdown-menu" i], [role=listbox], [class*="tooltip" i], [data-career-overlay]'
    const MASK_RX = /(^|[\s_-])(mask|overlay|backdrop)([\s_-]|$)/i
    let mask = false
    const roots: Element[] = []
    for (const el of Array.from(document.querySelectorAll(SEL))) {
      if (el === document.body || el === document.documentElement) continue
      if (el.closest(EXCLUDE) || !shown(el)) continue
      const cls = typeof el.className === 'string' ? el.className : ''
      const text = clean((el as HTMLElement).innerText)
      if (MASK_RX.test(cls) && !text) { mask = true; continue }
      if (!text) continue
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const floating = cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky'
      if (!floating && r.width * r.height > vw * vh * 0.6) continue // 文档流里的大容器（布局类名碰巧带 modal / popup）
      // 内容本身就是表单（抽屉里的网申表）：不是障碍
      const inputs = Array.from(el.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select')).filter(shown)
      if (inputs.length >= 2) continue
      // 只保留最外层
      if (roots.some(x => x.contains(el))) continue
      for (let i = roots.length - 1; i >= 0; i--) if (el.contains(roots[i])) roots.splice(i, 1)
      roots.push(el)
    }
    const dialogs: DialogInfo[] = []
    roots.forEach((root, i) => {
      const buttons: DialogButton[] = []
      // `[class*=btn]` 也会命中按钮外面的容器（如 `xx-footer-btns`）；容器在文档顺序里排在前面，
      // 先收了它就会把两个按钮的文字拼成一个"按钮"。所以先收齐候选，只留不包含其他候选的最内层元素。
      const candidates = Array.from(root.querySelectorAll('button, [role=button], a, [class*="btn" i], [class*="close" i], [aria-label*="关闭"], [aria-label*="close" i]'))
        .filter(b => shown(b) || b.getBoundingClientRect().width >= 8)
        .map(b => {
          const cls = typeof b.className === 'string' ? b.className : ''
          let text = clean((b as HTMLElement).innerText || b.getAttribute('aria-label') || b.getAttribute('title'))
          if (!text && /close/i.test(cls)) text = '关闭'
          return { b, text }
        })
        .filter(c => c.text && c.text.length <= 30)
      const leaves = candidates.filter(c => !candidates.some(o => o !== c && c.b.contains(o.b)))
      let j = 0
      for (const { b, text } of leaves) {
        const id = `d${i}b${j++}`
        b.setAttribute('data-career-dlg-btn', id)
        buttons.push({ id, text, selector: `[data-career-dlg-btn="${id}"]` })
      }
      const cls = `${typeof root.className === 'string' ? root.className : ''} ${root.id}`
      const text = clean((root as HTMLElement).innerText).slice(0, 400)
      const cookie = /cookie|consent/i.test(cls) || /cookie|隐私偏好|cookies? 设置/i.test(text)
      const cs = getComputedStyle(root)
      const r = root.getBoundingClientRect()
      const modal = root.getAttribute('aria-modal') === 'true' || /modal|dialog/i.test(cls) || root.getAttribute('role') === 'dialog' || root.getAttribute('role') === 'alertdialog' || mask || (cs.position === 'fixed' && r.width * r.height > vw * vh * 0.15)
      dialogs.push({ id: `d${i}`, text, buttons, modal, kind: cookie ? 'cookie' : 'dialog' })
    })
    return { dialogs, mask }
  },
}

// ---------------------------------------------------------------------------
// 自定义下拉：点开 → 枚举弹出层选项（打 data-career-opt 标记）；可搜索时允许键入关键字再枚举
// ---------------------------------------------------------------------------
export interface OptionInfo { id: string; text: string; disabled?: boolean }
export interface OpenOptionsArg { selector: string; reopen?: boolean; waitMs?: number }
export interface OpenOptionsResult { opened: boolean; options: OptionInfo[]; searchable: boolean; cascade: boolean; detail?: string }
export const openOptionsScript: PageScript<OpenOptionsArg, OpenOptionsResult> = {
  id: WIDGET_SCRIPT_IDS.openOptions,
  fn: async ({ selector, reopen, waitMs }) => {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return { opened: false, options: [], searchable: false, cascade: false, detail: '元素不存在' }
    const SHELL = '.ant-select, .ant-cascader, .el-select, .el-cascader, .ivu-select, .mtd-select, .mtd-cascader, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, [class*="select" i], [class*="cascader" i], [role=combobox]'
    const shell = ((el.parentElement ? el.parentElement.closest(SHELL) : null) as HTMLElement | null) ?? el
    const vis = (n: Element) => { const r = n.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(n); return cs.visibility !== 'hidden' && cs.display !== 'none' }
    const OPT = '[role=option], [class*="select-item" i]:not([class*="group" i]), [class*="select-option" i], [class*="dropdown" i] li, [class*="select" i] li, [class*="popper" i] li, [class*="cascader" i] li, [class*="cascader-node" i], [class*="menu-item" i], .layui-anim dd, [class*="option" i]:not([class*="options" i]):not(select):not(option)'
    const fire = (n: Element) => {
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }
    const collect = () => Array.from(document.querySelectorAll(OPT)).filter(n => vis(n) && n !== el && !n.contains(el) && !n.closest('[class*="selection" i], [data-career-overlay]') && !n.querySelector(OPT) && clean(n.textContent).length > 0 && clean(n.textContent).length <= 60)
    const before = new Set(collect())
    if (!reopen) {
      const trigger = (shell.querySelector('.ant-select-selector, .el-select__wrapper, .el-input, .ivu-select-selection, .mtd-select-selection, [class*="selection" i], [class*="trigger" i]') as HTMLElement | null) ?? shell
      try { el.focus({ preventScroll: true }) } catch { /* ignore */ }
      fire(trigger)
    }
    let nodes: Element[] = []
    const deadline = Date.now() + (waitMs ?? 1500)
    while (Date.now() < deadline) {
      await sleep(120)
      nodes = collect()
      if (nodes.length && (reopen || nodes.some(n => !before.has(n)) || before.size === 0)) break
    }
    if (!nodes.length) return { opened: false, options: [], searchable: false, cascade: false, detail: '点开后没有出现选项' }
    // 同一弹出层：取离字段最近的那个容器里的选项
    const POP = '[class*="dropdown" i], [class*="popper" i], [class*="popup" i], [role=listbox], [class*="menu" i], [class*="cascader" i], .layui-anim'
    const groups = new Map<Element, Element[]>()
    for (const n of nodes) { const c = n.closest(POP) ?? document.body; groups.set(c, [...(groups.get(c) ?? []), n]) }
    const fr = shell.getBoundingClientRect()
    let best: Element[] = nodes
    let bestDist = Infinity
    for (const [c, list] of groups) {
      const r = c.getBoundingClientRect()
      const dist = Math.abs(r.top - fr.bottom) + Math.abs(r.left - fr.left) + (list.some(n => !before.has(n)) ? 0 : 5000)
      if (dist < bestDist) { bestDist = dist; best = list }
    }
    const options: OptionInfo[] = best.slice(0, 300).map((n, i) => {
      const id = `o${i}`
      n.setAttribute('data-career-opt', id)
      const cls = typeof n.className === 'string' ? n.className : ''
      return { id, text: clean(n.textContent), disabled: /disabled/i.test(cls) || n.getAttribute('aria-disabled') === 'true' || undefined }
    })
    const ae = document.activeElement as HTMLInputElement | null
    const searchable = !!ae && ae.tagName === 'INPUT' && !ae.readOnly && !ae.disabled && (shell.contains(ae) || !!ae.closest(POP))
    const cascade = best.some(n => /cascader/i.test(`${(n.closest(POP) as HTMLElement | null)?.className ?? ''} ${typeof n.className === 'string' ? n.className : ''}`))
    return { opened: true, options, searchable, cascade }
  },
}

export interface PickOptionResult { ok: boolean; display: string; next?: OptionInfo[]; stillOpen?: boolean; detail?: string }
export const pickOptionScript: PageScript<{ selector: string; optId: string; settleMs?: number }, PickOptionResult> = {
  id: WIDGET_SCRIPT_IDS.pickOption,
  fn: async ({ selector, optId, settleMs }) => {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const el = document.querySelector(selector) as HTMLElement | null
    const opt = document.querySelector(`[data-career-opt="${optId}"]`) as HTMLElement | null
    if (!el || !opt) return { ok: false, display: '', detail: el ? '选项不见了' : '元素不存在' }
    try { opt.scrollIntoView({ block: 'nearest' }) } catch { /* ignore */ }
    const fire = (n: Element) => {
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }
    const vis = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 2 && r.height >= 2 && getComputedStyle(n).visibility !== 'hidden' }
    const popup = opt.closest('[class*="dropdown" i], [class*="popper" i], [class*="popup" i], [role=listbox], [class*="menu" i], [class*="cascader" i], .layui-anim')
    const cascadeCols = () => popup ? Array.from(popup.querySelectorAll('[class*="cascader-menu" i]:not([class*="menus" i]), [class*="cascader-list" i], [class*="cascader-panel" i] ul, [role=menu]')).filter(vis).length : 0
    const colsBefore = cascadeCols()
    fire(opt)
    await sleep(settleMs ?? 250)
    const SHELL = '.ant-select, .ant-cascader, .el-select, .el-cascader, .ivu-select, .mtd-select, .mtd-cascader, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, [class*="select" i], [class*="cascader" i], [role=combobox]'
    const shell = (el.parentElement ? el.parentElement.closest(SHELL) : null) as HTMLElement | null
    const display = () => {
      if (shell) {
        for (const n of Array.from(shell.querySelectorAll('[class*="selection-item" i], [class*="selected-value" i], [class*="single-value" i], [class*="selection__rendered" i], [class*="selected-item" i], [class*="select-value" i], [class*="label" i]:not(label)'))) {
          const c = typeof n.className === 'string' ? n.className : ''
          if (/placeholder/i.test(c) || !vis(n)) continue
          const t = clean(n.textContent); if (t) return t
        }
        for (const i of Array.from(shell.querySelectorAll('input'))) { const v = clean((i as HTMLInputElement).value); if (v) return v }
      }
      return clean((el as HTMLInputElement).value ?? el.textContent)
    }
    if (popup && cascadeCols() > colsBefore) {
      const OPT = '[role=option], [class*="cascader" i] li, [class*="cascader-node" i], [class*="menu-item" i]'
      const cols = Array.from(popup.querySelectorAll('[class*="cascader-menu" i]:not([class*="menus" i]), [class*="cascader-list" i], [class*="cascader-panel" i] ul, [role=menu]')).filter(vis)
      const last = cols[cols.length - 1]
      const next = Array.from(last.querySelectorAll(OPT)).filter(n => vis(n) && !n.querySelector(OPT)).slice(0, 300).map((n, i) => { const id = `c${colsBefore}o${i}`; n.setAttribute('data-career-opt', id); return { id, text: clean(n.textContent) } })
      if (next.length) return { ok: true, display: display(), next, stillOpen: true }
    }
    return { ok: true, display: display(), stillOpen: !!popup && vis(popup) }
  },
}

/** 收起弹出层：Esc + 在空白处按下（不点任何按钮），再失焦。 */
export const closePopupScript: PageScript<{ selector?: string }, boolean> = {
  id: WIDGET_SCRIPT_IDS.closePopup,
  fn: async ({ selector }) => {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const target = (document.activeElement as HTMLElement | null) ?? document.body
    for (const t of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(t, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }))
    await sleep(60)
    for (const t of ['mousedown', 'mouseup']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: 1, clientY: 1 }))
    const el = selector ? document.querySelector(selector) as HTMLElement | null : null
    try { el?.blur(); (document.activeElement as HTMLElement | null)?.blur?.() } catch { /* ignore */ }
    await sleep(80)
    return true
  },
}

/** 用户可见的显示值：自定义下拉读选中项展示文字（不读隐藏 input），原生控件读值。 */
export interface ReadDisplayResult { exists: boolean; display: string }
export const readDisplayScript: PageScript<{ selector: string }, ReadDisplayResult> = {
  id: WIDGET_SCRIPT_IDS.readDisplay,
  fn: ({ selector }) => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return { exists: false, display: '' }
    const vis = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 2 && r.height >= 2 && getComputedStyle(n).visibility !== 'hidden' }
    const SHELL = '.ant-select, .ant-picker, .ant-cascader, .el-select, .el-date-editor, .el-cascader, .ivu-select, .ivu-date-picker, .mtd-select, .mtd-picker, .mtd-date-picker, .mtd-cascader, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, [class*="select" i], [class*="picker" i], [class*="cascader" i], [role=combobox]'
    const shell = el.parentElement ? el.parentElement.closest(SHELL) : null
    if (el.tagName === 'SELECT') { const s = el as HTMLSelectElement; return { exists: true, display: s.selectedIndex >= 0 ? clean(s.options[s.selectedIndex]?.textContent) : '' } }
    if (shell) {
      for (const n of Array.from(shell.querySelectorAll('[class*="selection-item" i], [class*="selected-value" i], [class*="single-value" i], [class*="selection__rendered" i], [class*="selected-item" i], [class*="select-value" i], [class*="label" i]:not(label)'))) {
        const c = typeof n.className === 'string' ? n.className : ''
        if (/placeholder/i.test(c) || !vis(n)) continue
        const t = clean(n.textContent); if (t) return { exists: true, display: t }
      }
      for (const i of Array.from(shell.querySelectorAll('input'))) { const v = clean((i as HTMLInputElement).value); if (v && vis(i)) return { exists: true, display: v } }
      return { exists: true, display: clean((el as HTMLInputElement).value ?? '') }
    }
    if (el.isContentEditable) return { exists: true, display: clean(el.innerText) }
    return { exists: true, display: clean((el as HTMLInputElement).value ?? el.textContent) }
  },
}

// ---------------------------------------------------------------------------
// 日期 / 月份：能输入先输入再核验；否则点开面板，按 年 → 月（→ 日）导航点击
// ---------------------------------------------------------------------------
export interface DatePickArg { selector: string; y: number; m: number; d?: number; text: string; typable: boolean }
export interface DatePickResult { ok: boolean; display: string; strategy: 'typed' | 'panel' | 'none'; steps: number; detail?: string }
export const datePickScript: PageScript<DatePickArg, DatePickResult> = {
  id: WIDGET_SCRIPT_IDS.datePick,
  fn: async ({ selector, y, m, d, text, typable }) => {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const el = document.querySelector(selector) as HTMLInputElement | null
    if (!el) return { ok: false, display: '', strategy: 'none', steps: 0, detail: '元素不存在' }
    const vis = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 2 && r.height >= 2 && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none' }
    const shell = (el.parentElement?.closest('[class*="picker" i], [class*="date" i], [class*="calendar" i]') as HTMLElement | null) ?? el
    const fire = (n: Element) => {
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }
    const display = () => {
      const v = clean(el.value)
      if (v) return v
      for (const n of Array.from(shell.querySelectorAll('[class*="value" i], [class*="text" i], input'))) { const t = clean((n as HTMLInputElement).value ?? n.textContent); if (t) return t }
      return ''
    }
    const digits = (s: string) => (s.match(/\d+/g) || []).map(Number)
    const okDisplay = () => { const n = digits(display()); return n[0] === y && n[1] === m && (d === undefined || n[2] === d) }
    const outside = () => { for (const t of ['mousedown', 'mouseup', 'click']) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: 1, clientY: 1 })) }
    // 1. 可输入：原型链 setter + input/change，回车只在可编辑输入框上
    if (typable && !el.readOnly) {
      const proto = Object.getPrototypeOf(el)
      const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      el.focus()
      set?.call(el, text)
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
      for (const t of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
      await sleep(200)
      el.dispatchEvent(new Event('blur')); el.blur(); outside()
      await sleep(200)
      if (okDisplay()) return { ok: true, display: display(), strategy: 'typed', steps: 0 }
      set?.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    // 2. 面板
    fire(el); if (shell !== el) fire(shell)
    const PANEL = '[class*="picker-panel" i], [class*="date-panel" i], [class*="calendar" i], [class*="datepicker" i], [class*="picker-dropdown" i], [class*="picker-popup" i], [class*="picker" i][class*="popper" i], [class*="month-panel" i], [class*="year-panel" i], [class*="picker-container" i]'
    let panel: Element | null = null
    for (let i = 0; i < 12 && !panel; i++) {
      await sleep(120)
      const cands = Array.from(document.querySelectorAll(PANEL)).filter(p => vis(p) && !p.contains(el) && /\d{4}/.test(p.textContent || ''))
      panel = cands.filter(p => !cands.some(o => o !== p && o.contains(p)))[0] ?? null
    }
    if (!panel) return { ok: false, display: display(), strategy: 'none', steps: 0, detail: '没有看到日期面板' }
    const MONTH_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
    const MONTH_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const monthOf = (t: string): number | null => {
      const s = t.toLowerCase()
      let mm = s.match(/^(\d{1,2})\s*月$/); if (mm) return +mm[1]
      mm = s.match(/^(一|二|三|四|五|六|七|八|九|十|十一|十二)月$/); if (mm) return MONTH_CN.indexOf(mm[1]) + 1
      const en = MONTH_EN.findIndex(x => s.startsWith(x)); if (en >= 0 && s.length <= 9) return en + 1
      return null
    }
    const cellsOf = (p: Element) => Array.from(p.querySelectorAll('td, li, button, a, span, div, [class*="cell" i]')).filter(n => vis(n) && n.children.length <= 1 && clean(n.textContent).length > 0 && clean(n.textContent).length <= 6)
    const otherMonth = (n: Element) => { const c = `${typeof n.className === 'string' ? n.className : ''} ${typeof (n.parentElement?.className) === 'string' ? n.parentElement!.className : ''}`; return /prev-month|next-month|other|outside|last-month|not-current|disabled|is-disabled/i.test(c) }
    const header = () => {
      const h = panel!.querySelector('[class*="header" i], [class*="head" i], [class*="title" i], caption')
      return clean((h ?? panel!).textContent)
    }
    const navBtn = (rx: RegExp) => Array.from(panel!.querySelectorAll('button, a, span, i, div, [role=button]')).filter(vis).find(n => {
      const sig = `${typeof n.className === 'string' ? n.className : ''} ${n.getAttribute('aria-label') ?? ''} ${n.getAttribute('title') ?? ''} ${n.children.length === 0 ? clean(n.textContent) : ''}`
      return rx.test(sig)
    })
    const PREV_YEAR = /super-prev|prev-year|year-prev|double-left|arrow-double-left|d-arrow-left|上一年|前一年|prev year|«|<</i
    const NEXT_YEAR = /super-next|next-year|year-next|double-right|arrow-double-right|d-arrow-right|下一年|后一年|next year|»|>>/i
    const PREV_MONTH = /(^|\s|-)prev(-btn|-month|-icon)?(\s|$)|month-prev|arrow-left|上个月|上一月|prev month|‹/i
    const NEXT_MONTH = /(^|\s|-)next(-btn|-month|-icon)?(\s|$)|month-next|arrow-right|下个月|下一月|next month|›/i
    let steps = 0
    let switched = false
    for (; steps < 60; steps++) {
      if (!vis(panel)) break
      const cells = cellsOf(panel)
      const years = cells.filter(n => /^\d{4}$/.test(clean(n.textContent)))
      const months = cells.filter(n => monthOf(clean(n.textContent)) !== null)
      const days = cells.filter(n => /^\d{1,2}$/.test(clean(n.textContent)) && !otherMonth(n))
      const hy = (header().match(/(\d{4})/) || [])[1]
      const headYear = hy ? +hy : NaN
      if (years.length >= 6 && months.length < 10) {
        const hit = years.find(n => +clean(n.textContent) === y)
        if (hit) { fire(hit); await sleep(180); continue }
        const nums = years.map(n => +clean(n.textContent))
        const b = navBtn(y < Math.min(...nums) ? PREV_YEAR : NEXT_YEAR)
        if (!b) break
        fire(b); await sleep(150); continue
      }
      if (months.length >= 10) {
        if (!Number.isFinite(headYear)) break
        if (headYear !== y) {
          const b = navBtn(y < headYear ? PREV_YEAR : NEXT_YEAR) ?? navBtn(y < headYear ? PREV_MONTH : NEXT_MONTH)
          if (!b) break
          fire(b); await sleep(150); continue
        }
        const hit = months.find(n => monthOf(clean(n.textContent)) === m)
        if (!hit) break
        fire(hit); await sleep(220)
        if (d === undefined) break
        continue
      }
      if (days.length >= 28) {
        const hm = header().match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})/) ?? header().match(/(\d{1,2})\s*月\s*(\d{4})/)
        let hY = NaN, hM = NaN
        if (hm) { if (hm[1].length === 4) { hY = +hm[1]; hM = +hm[2] } else { hM = +hm[1]; hY = +hm[2] } }
        if (d === undefined) {
          // 只要年月：试着切到月份面板（点头部的年 / 月）
          if (switched) break
          const lab = Array.from(panel.querySelectorAll('[class*="header" i] *, [class*="head" i] *')).filter(vis).find(n => n.children.length === 0 && /\d{4}\s*年?|\d{1,2}\s*月/.test(clean(n.textContent)))
          if (!lab) break
          switched = true; fire(lab); await sleep(200); continue
        }
        if (!Number.isFinite(hY) || !Number.isFinite(hM)) break
        if (hY !== y || hM !== m) {
          const forward = hY < y || (hY === y && hM < m)
          const yearsOff = Math.abs(hY - y)
          const b = (yearsOff >= 1 ? navBtn(forward ? NEXT_YEAR : PREV_YEAR) : null) ?? navBtn(forward ? NEXT_MONTH : PREV_MONTH)
          if (!b) break
          fire(b); await sleep(150); continue
        }
        const hit = days.find(n => +clean(n.textContent) === d)
        if (!hit) break
        fire(hit); await sleep(220)
        break
      }
      break
    }
    // 有"确定"就点（只在面板内），然后收起
    if (vis(panel)) {
      const okBtn = Array.from(panel.querySelectorAll('button, a, [role=button]')).filter(vis).find(n => /^(确定|确认|ok)$/i.test(clean(n.textContent)))
      if (okBtn && okDisplay() === false) { fire(okBtn); await sleep(150) }
      else if (okBtn) { fire(okBtn); await sleep(150) }
    }
    try { el.blur() } catch { /* ignore */ }
    outside(); await sleep(200)
    return { ok: okDisplay(), display: display(), strategy: 'panel', steps, detail: okDisplay() ? undefined : `面板导航 ${steps} 步后显示「${display()}」` }
  },
}

// ---------------------------------------------------------------------------
// 焦点 / 选区 / 入口链接 / 截图打码 / 组件库指纹 / 必填标记统计 / 失败 DOM 片段
// ---------------------------------------------------------------------------
export interface ActiveEditableResult { editable: boolean; isTarget: boolean; tag: string }
/** 焦点检查：selector 给定时焦点必须在它上面；x/y 给定时焦点必须就是该坐标处的元素（视觉层点击后用）。 */
export const activeEditableScript: PageScript<{ selector?: string; x?: number; y?: number }, ActiveEditableResult> = {
  id: WIDGET_SCRIPT_IDS.activeEditable,
  fn: ({ selector, x, y }) => {
    const ae = document.activeElement as HTMLElement | null
    if (!ae || ae === document.body) return { editable: false, isTarget: false, tag: ae?.tagName.toLowerCase() ?? '' }
    const i = ae as HTMLInputElement
    const type = (i.type || '').toLowerCase()
    const textLike = (ae.tagName === 'INPUT' && !['checkbox', 'radio', 'file', 'button', 'submit', 'image', 'reset', 'range', 'color'].includes(type)) || ae.tagName === 'TEXTAREA' || ae.isContentEditable
    const editable = textLike && !i.readOnly && !i.disabled
    const t = selector ? document.querySelector(selector) : (typeof x === 'number' && typeof y === 'number' ? document.elementFromPoint(x, y) : null)
    const isTarget = selector || typeof x === 'number' ? !!t && (t === ae || t.contains(ae) || ae.contains(t)) : true
    return { editable, isTarget, tag: ae.tagName.toLowerCase() }
  },
}
export interface PageSelectionResult { chars: number; whole: boolean; collapsed: boolean }
export const pageSelectionScript: PageScript<{ collapse?: boolean }, PageSelectionResult> = {
  id: WIDGET_SCRIPT_IDS.pageSelection,
  fn: ({ collapse }) => {
    const sel = window.getSelection()
    const chars = sel ? sel.toString().length : 0
    const body = (document.body?.innerText || '').length
    const whole = chars > 40 && chars >= body * 0.4
    let collapsed = false
    if (whole && collapse && sel) { sel.removeAllRanges(); collapsed = true }
    return { chars, whole, collapsed }
  },
}
export const prepareEntryClickScript: PageScript<{ selector: string }, { ok: boolean; href?: string }> = {
  id: WIDGET_SCRIPT_IDS.prepareEntryClick,
  fn: ({ selector }) => {
    const el = document.querySelector(selector)
    if (!el) return { ok: false }
    const a = el.closest('a') as HTMLAnchorElement | null
    if (a && a.target && a.target !== '_self') a.removeAttribute('target') // 新标签页打开的入口改为当前页打开，引擎才能跟上
    return { ok: true, href: a?.href }
  },
}
export const maskSensitiveScript: PageScript<{ on: boolean; selectors?: string[] }, boolean> = {
  id: WIDGET_SCRIPT_IDS.maskSensitive,
  fn: ({ on, selectors }) => {
    const id = '__career_mask_style'
    document.getElementById(id)?.remove()
    if (!on || !selectors?.length) return true
    const st = document.createElement('style')
    st.id = id
    st.textContent = `${selectors.join(', ')} { filter: blur(6px) !important; }`
    document.documentElement.appendChild(st)
    return true
  },
}
export const libraryFingerprintScript: PageScript<void, string[]> = {
  id: WIDGET_SCRIPT_IDS.libraryFingerprint,
  fn: () => {
    const out: string[] = []
    const has = (sel: string) => { try { return !!document.querySelector(sel) } catch { return false } }
    const pairs: Array<[string, string]> = [['mtd', '[class*="mtd-"]'], ['antd', '[class*="ant-"]'], ['element', '[class*="el-"]'], ['iview', '[class*="ivu-"]'], ['vant', '[class*="van-"]'], ['arco', '[class*="arco-"]'], ['tdesign', '[class*="t-form"], [class*="t-input"]'], ['layui', '[class*="layui-"]'], ['fusion', '[class*="next-"]'], ['atsx', '[class*="atsx-"]']]
    for (const [name, sel] of pairs) if (has(sel)) out.push(name)
    const host = location.hostname
    if (/beisen|italent/i.test(host)) out.push('beisen')
    if (/mokahr/i.test(host)) out.push('moka')
    if (/feishu|larksuite/i.test(host)) out.push('feishu')
    return out
  },
}
export interface FormStats { markers: number; controls: number }
export const formStatsScript: PageScript<void, FormStats> = {
  id: WIDGET_SCRIPT_IDS.formStats,
  fn: () => {
    const vis = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 }
    let markers = 0
    for (const n of Array.from(document.querySelectorAll('label, span, i, em, b, [class*="label" i], [class*="required" i], [class*="star" i], [class*="asterisk" i]')).slice(0, 3000)) {
      if (!vis(n) || n.closest('[data-career-overlay]')) continue
      const own = n.children.length === 0 ? (n.textContent || '').trim() : ''
      const before = getComputedStyle(n, '::before').content
      if (own === '*' || own === '＊' || /^"[*＊]/.test(before)) markers++
    }
    const controls = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [contenteditable="true"]')).filter(vis).length
    return { markers, controls }
  },
}
export const domSnippetScript: PageScript<{ selector: string; max?: number }, string> = {
  id: WIDGET_SCRIPT_IDS.domSnippet,
  fn: ({ selector, max }) => {
    const el = document.querySelector(selector)
    if (!el) return ''
    const root = el.closest('[class*="form-item" i], [class*="form-group" i], [class*="field" i]') ?? el.parentElement ?? el
    const html = root.outerHTML.replace(/value="[^"]*"/g, 'value="…"')
    return html.slice(0, max ?? 4000)
  },
}
