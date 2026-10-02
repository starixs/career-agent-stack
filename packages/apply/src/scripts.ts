/**
 * 在浏览器里执行的纯 DOM 脚本。每个脚本带稳定 id：
 *  - 真实 Page（fromPlaywright）把 fn 序列化后在页面里执行；
 *  - FakePage 不跑 DOM，而是按 id 用内存模型回答同样的问题。
 * 脚本函数必须自包含（不能引用模块作用域的变量），因为会被 toString 后注入页面。
 *
 * 注意：这些 DOM 脚本只能在真实浏览器里验证，单元测试覆盖的是 FakePage 分支。
 */

export interface PageScript<A, R> { id: string; fn: (arg: A) => R }

export type FieldType = 'text' | 'email' | 'tel' | 'number' | 'date' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'richtext'

/** 抽取脚本的原始输出（extract.ts 再整理成 FormField）。 */
export interface RawField {
  id: string
  label: string
  name?: string
  type: FieldType
  options?: string[]
  required: boolean
  value?: string
  maxLength?: number
  placeholder?: string
  /** 自定义下拉（antd / element-ui 之类），选项要点开才出现。 */
  custom?: boolean
}

export interface ButtonInfo { id: string; text: string; selector: string; disabled: boolean }

/** 页面信号：供阻碍检测、按钮查找、上传回显检查使用。 */
export interface PageSignals {
  url: string
  title: string
  /** 页面可见文本（截断）。 */
  text: string
  hasPasswordInput: boolean
  captchaDom: boolean
  buttons: ButtonInfo[]
  fileInputs: number
  fieldCount: number
  /** 可见的校验错误提示。 */
  errors: string[]
}

export const SCRIPT_IDS = {
  extractFields: 'career.extractFields',
  pageSignals: 'career.pageSignals',
  scrollBy: 'career.scrollBy',
  domBoxes: 'career.domBoxes',
  elementAt: 'career.elementAt',
} as const

/** DOM 可见元素的视口包围盒（给视觉层做"DOM 盒子 + OCR 文字"的混合感知）。 */
export interface DomBox { kind: 'input' | 'button' | 'text' | 'select' | 'checkbox' | 'radio' | 'link'; text: string; x: number; y: number; w: number; h: number }
export const domBoxesScript: PageScript<void, DomBox[]> = {
  id: SCRIPT_IDS.domBoxes,
  fn: () => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    const out: DomBox[] = []
    const vw = window.innerWidth, vh = window.innerHeight
    const push = (kind: DomBox['kind'], el: Element, text: string) => {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return
      out.push({ kind, text: clean(text), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
    }
    const vis = (el: Element) => { const h = el as HTMLElement; if (h.offsetParent === null) { try { return getComputedStyle(h).position === 'fixed' } catch { return false } } return true }
    for (const el of Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="textbox"]'))) {
      if (!vis(el)) continue
      const input = el as HTMLInputElement
      const t = (input.type || '').toLowerCase()
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(t)) continue
      const kind: DomBox['kind'] = t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : (el.tagName === 'SELECT' || el.getAttribute('role') === 'combobox') ? 'select' : 'input'
      push(kind, el, input.placeholder || input.getAttribute('aria-label') || '')
    }
    for (const el of Array.from(document.querySelectorAll('button, a[href], input[type="submit"], input[type="button"], [role="button"]'))) {
      if (!vis(el)) continue
      const text = (el as HTMLElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || ''
      if (!clean(text)) continue
      push(el.tagName === 'A' ? 'link' : 'button', el, text)
    }
    for (const el of Array.from(document.querySelectorAll('label, legend, th, dt, [class*="label" i], [class*="title" i], h1, h2, h3, h4, h5, p, span, div'))) {
      if (out.length > 600) break
      if (!vis(el)) continue
      // 只要"叶子"文本：没有块级子元素
      if (el.children.length > 3) continue
      const text = clean(el.textContent)
      if (!text || text.length > 60) continue
      if (el.closest('button, a, select, option')) continue
      push('text', el, text)
    }
    return out
  },
}

/** 坐标处是什么元素（视觉层点击前 / 后回查 DOM）。 */
export const elementAtScript: PageScript<{ x: number; y: number }, { tag: string; type?: string; label?: string } | null> = {
  id: SCRIPT_IDS.elementAt,
  fn: ({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return null
    return { tag: el.tagName.toLowerCase(), type: (el as HTMLInputElement).type || undefined, label: (el.getAttribute('aria-label') || (el as HTMLInputElement).placeholder || el.textContent || '').trim().slice(0, 80) || undefined }
  },
}

/** 抽取表单字段并给每个控件打上 data-career-field 标记（radio 组额外打 data-career-option）。 */
export const extractFieldsScript: PageScript<void, RawField[]> = {
  id: SCRIPT_IDS.extractFields,
  fn: () => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const stripStar = (s: string) => s.replace(/^[\s*＊]+|[\s*＊:：]+$/g, '').trim()
    const isGeneric = (s: string) => /^(请选择|请输入|选择|输入|搜索|search|select|choose|type|--|please select|e\.?g\.?)/i.test(s.trim())
    const ok = (s: string | null | undefined) => { const t = (s || '').trim(); return t && !isGeneric(t) ? t : '' }
    const vis = (el: Element) => {
      const h = el as HTMLElement
      if (h.offsetParent !== null) return true
      try { return getComputedStyle(h).position === 'fixed' } catch { return false }
    }
    const pure = (node: Element | null): string => {
      if (!node) return ''
      const c = node.cloneNode(true) as Element
      c.querySelectorAll?.('input, select, textarea, option, button, [role=option], [role=listbox]').forEach(n => n.remove())
      return stripStar(clean(c.textContent))
    }
    const WRAP = '[class*="form-item" i], [class*="form-group" i], [class*="field" i], [class*="question" i], fieldset, li, tr'
    const LABEL = 'label, legend, [class*="form-item__label" i], [class*="form-item-label" i], [class*="label" i], [class*="title" i], h3, h4, h5'
    const wrapperOf = (el: Element) => el.closest(WRAP)
    function labelFor(el: Element): string {
      const aria = el.getAttribute('aria-label'); if (ok(aria)) return stripStar(aria!)
      const lb = el.getAttribute('aria-labelledby')
      if (lb) { const t = lb.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '); if (ok(t)) return stripStar(clean(t)) }
      const id = (el as HTMLElement).id
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (l && ok(pure(l))) return pure(l) }
      const pl = el.closest('label'); if (pl && ok(pure(pl))) return pure(pl)
      const w = wrapperOf(el)
      if (w) { const l = w.querySelector(LABEL); if (l && ok(pure(l))) return pure(l) }
      let c: Element | null = el.parentElement
      for (let i = 0; i < 4 && c; i++, c = c.parentElement) { const l = c.querySelector(LABEL); if (l && ok(pure(l))) return pure(l) }
      const ph = (el as HTMLInputElement).placeholder; if (ok(ph)) return stripStar(ph)
      return stripStar(ok((el as HTMLInputElement).name))
    }
    function groupLabel(first: Element, options: string[]): string {
      const rg = first.closest('[role=radiogroup], fieldset, [class*="radio-group" i]')
      if (rg) {
        const al = rg.getAttribute('aria-label'); if (al) return stripStar(al)
        const lg = rg.querySelector('legend'); if (lg?.textContent?.trim()) return stripStar(clean(lg.textContent))
      }
      const set = new Set(options.map(o => o.toLowerCase()))
      const cont = wrapperOf(rg || first) || first.parentElement?.parentElement || first.parentElement
      if (cont) for (const c of Array.from(cont.querySelectorAll(LABEL))) {
        const t = pure(c); if (t && t.length > 1 && t.length < 160 && !set.has(t.toLowerCase())) return t
      }
      return ''
    }
    const requiredOf = (el: Element) => {
      if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') return true
      const w = wrapperOf(el)
      if (!w) return false
      if (/(^|\s)(is-required|required|ant-form-item-required)(\s|$)/i.test(w.className || '')) return true
      const l = w.querySelector(LABEL)
      return !!l && /[*＊]/.test(clean(l.textContent))
    }
    const out: RawField[] = []
    const seenRadio = new Set<string>()
    let n = 0
    const els = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"]'))
    for (const el of els) {
      const tag = el.tagName.toLowerCase()
      const itype = ((el as HTMLInputElement).type || '').toLowerCase()
      const role = el.getAttribute('role') || ''
      if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(itype)) continue
      const isFile = itype === 'file'
      if (!isFile && itype !== 'radio' && itype !== 'checkbox' && !vis(el)) continue
      if (el.closest('[class*="search" i][class*="box" i], [role="search"]')) continue
      const name = (el as HTMLInputElement).name || (el as HTMLElement).id || undefined
      const required = requiredOf(el)
      if (itype === 'radio') {
        const rn = (el as HTMLInputElement).name
        if (rn && seenRadio.has(rn)) continue
        if (rn) seenRadio.add(rn)
        const group = rn ? Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(rn)}"]`)) : [el]
        const id = `f${n++}`
        const options = group.map(r => clean(labelFor(r) || (r as HTMLInputElement).value)).filter(Boolean)
        let value: string | undefined
        group.forEach((r, i) => { r.setAttribute('data-career-field', id); r.setAttribute('data-career-option', options[i] ?? String(i)); if ((r as HTMLInputElement).checked) value = options[i] })
        out.push({ id, label: clean(groupLabel(el, options)) || rn || '', name: rn, type: 'radio', options, required, value })
        continue
      }
      const id = `f${n++}`
      el.setAttribute('data-career-field', id)
      if (tag === 'select') {
        const sel = el as HTMLSelectElement
        const options = Array.from(sel.options).map(o => clean(o.textContent)).filter(o => o && !isGeneric(o))
        const cur = sel.selectedIndex >= 0 ? clean(sel.options[sel.selectedIndex]?.textContent) : ''
        out.push({ id, label: clean(labelFor(el)), name, type: 'select', options, required, value: cur && !isGeneric(cur) ? cur : undefined })
        continue
      }
      if (role === 'combobox' || el.closest('.ant-select, .el-select, [class*="select" i]')) {
        const shell = el.closest('.ant-select, .el-select, [class*="select" i]') || el
        const shown = clean((shell.querySelector('[class*="selection-item" i], [class*="single-value" i], .el-input__inner') as HTMLElement | null)?.textContent || (el as HTMLInputElement).value)
        out.push({ id, label: clean(labelFor(el)), name, type: 'select', options: [], required, custom: true, value: shown && !isGeneric(shown) ? shown : undefined })
        continue
      }
      if (el.getAttribute('contenteditable') === 'true') {
        out.push({ id, label: clean(labelFor(el)), name, type: 'richtext', required, value: clean((el as HTMLElement).innerText) || undefined })
        continue
      }
      let type: FieldType = 'text'
      if (tag === 'textarea') type = 'textarea'
      else if (['email', 'tel', 'number', 'date', 'checkbox', 'file'].includes(itype)) type = itype as FieldType
      const input = el as HTMLInputElement
      let value: string | undefined
      if (type === 'checkbox') value = input.checked ? 'true' : 'false'
      else if (type === 'file') value = input.files && input.files.length ? Array.from(input.files).map(f => f.name).join(', ') : undefined
      else value = input.value || undefined
      const ml = input.maxLength
      out.push({ id, label: clean(labelFor(el)), name, type, required, value, maxLength: ml && ml > 0 ? ml : undefined, placeholder: ok(input.placeholder) || undefined })
    }
    return out
  },
}

/** 页面信号：标题、可见文本、密码框、验证码 DOM、可见按钮（打 data-career-btn 标记）、错误提示。 */
export const pageSignalsScript: PageScript<void, PageSignals> = {
  id: SCRIPT_IDS.pageSignals,
  fn: () => {
    const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim()
    const vis = (el: Element) => {
      const h = el as HTMLElement
      if (h.offsetParent === null) { try { return getComputedStyle(h).position === 'fixed' } catch { return false } }
      const r = h.getBoundingClientRect(); return r.width > 1 && r.height > 1
    }
    const CAPTCHA = '.geetest_holder, .geetest_panel, [class*="geetest" i], .nc_wrapper, .nc-container, #captcha, [id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i], [class*="slider" i][class*="verify" i], [class*="verify" i][class*="slide" i], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #challenge-running, iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha.com"]'
    const captchaDom = Array.from(document.querySelectorAll(CAPTCHA)).some(vis)
    const hasPasswordInput = Array.from(document.querySelectorAll('input[type="password"]')).some(vis)
    const buttons: ButtonInfo[] = []
    let n = 0
    for (const b of Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]'))) {
      if (!vis(b)) continue
      const text = clean((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label') || b.getAttribute('title')).slice(0, 60)
      if (!text) continue
      const id = `b${n++}`
      b.setAttribute('data-career-btn', id)
      const disabled = (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true' || /(^|\s)(is-disabled|disabled)(\s|$)/.test(b.className || '')
      buttons.push({ id, text, selector: `[data-career-btn="${id}"]`, disabled })
      if (n >= 80) break
    }
    const errors: string[] = []
    for (const e of Array.from(document.querySelectorAll('[aria-invalid="true"] ~ *, [role="alert"], [class*="error" i]:not([class*="clear" i]), [class*="form-item__error" i], [class*="explain-error" i]'))) {
      if (!vis(e)) continue
      const t = clean(e.textContent); if (t && t.length > 1 && t.length < 160) errors.push(t)
    }
    const fieldCount = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [contenteditable="true"]')).filter(vis).length
    return {
      url: location.href,
      title: document.title,
      text: clean(document.body?.innerText).slice(0, 8000),
      hasPasswordInput,
      captchaDom,
      buttons,
      fileInputs: document.querySelectorAll('input[type="file"]').length,
      fieldCount,
      errors: Array.from(new Set(errors)).slice(0, 8),
    }
  },
}

export const scrollByScript: PageScript<number, number> = {
  id: SCRIPT_IDS.scrollBy,
  fn: (dy: number) => { window.scrollBy(0, dy); return window.scrollY },
}
