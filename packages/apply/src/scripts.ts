/**
 * 在浏览器里执行的纯 DOM 脚本。每个脚本带稳定 id：
 *  - 真实 Page（fromPlaywright）把 fn 序列化后在页面里执行；
 *  - FakePage 不跑 DOM，而是按 id 用内存模型回答同样的问题。
 * 脚本函数必须自包含（不能引用模块作用域的变量），因为会被 toString 后注入页面。
 *
 * 注意：这些 DOM 脚本只能在真实浏览器里验证，单元测试覆盖的是 FakePage 分支。
 */

export interface PageScript<A, R> { id: string; fn: (arg: A) => R | Promise<R> }

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
  /** 稳定定位键（站点记忆用）。 */
  xpath?: string
  /** 识别到的 UI 框架指纹（antd / element / iview / layui / mtd / kuma / fusion / phoenix / my97 / native）。 */
  framework?: string
  /** 只读（自定义下拉 / 日期面板的展示框）。 */
  readonly?: boolean
  /** 必填是怎么认出来的：attr / aria / class / star / pseudo。 */
  requiredVia?: string
  /** 标签可疑的原因（吸顶 / 导航栏文字、过长、纯数字、只有占位符…）；有值时引擎不敢按它填。 */
  labelUncertain?: string
}

export interface ButtonInfo { id: string; text: string; selector: string; disabled: boolean; /** 是普通链接时的去处（http/https）：只读导航，不是点击动作 */ href?: string }

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
  fillValue: 'career.fillValue',
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
    for (const n of Array.from(document.querySelectorAll('[data-career-proxy]'))) { n.removeAttribute('data-career-proxy'); n.removeAttribute('data-career-proxy-option') }
    // 字段编号在这一页上只增不复用：同一个格子再抽一次还是原来的号，新冒出来的格子拿新号。
    // 不能每次重编：上传简历后页面顶上多出一格「推荐方式」，重编后所有格子号往后错一位，按号填的值全串到了下一格（2026-11-03 库洛游戏）；
    // 也不能留着旧号再编新号：切了登录标签，藏起来的旧格子和新格子同号，选择器先命中看不见的那个（2026-11-03 手机号填进了藏起来的邮箱框）
    const seq = window as unknown as { __careerFieldSeq?: number }
    const taken = new Set<string>()
    const idFor = (el: Element) => {
      const old = el.getAttribute('data-career-field')
      if (old && !taken.has(old)) { taken.add(old); return old }
      // 第一次编号（或页面脚本状态丢了）：接着页面上已有的最大号往后编
      if (seq.__careerFieldSeq === undefined) {
        const nums = Array.from(document.querySelectorAll('[data-career-field]')).map(x => Number((x.getAttribute('data-career-field') || '').slice(1))).filter(Number.isFinite)
        seq.__careerFieldSeq = nums.length ? Math.max(...nums) + 1 : 0
      }
      const id = `f${seq.__careerFieldSeq++}`
      taken.add(id)
      return id
    }
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
    /** 最近一次 labelFor 用到的标签节点（组合控件判断"两个控件共用一个标签"用）。 */
    let labelNode: Element | null = null
    // 稳定 XPath（quillfill form-sensor）：唯一 id 直接用；否则逐级 tag[idx]，input 带 name / placeholder
    const xpathOf = (el: Element): string => {
      const id = (el as HTMLElement).id
      if (id && document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length === 1) return `//*[@id="${id}"]`
      const parts: string[] = []
      let node: Element | null = el
      while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
        let idx = 1; let sib = node.previousElementSibling
        while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling }
        let seg = `${node.tagName.toLowerCase()}[${idx}]`
        const nm = (node as HTMLInputElement).name
        if (nm && node.tagName === 'INPUT') seg += `[@name="${nm}"]`
        else if (node.getAttribute('placeholder')) seg += `[@placeholder="${node.getAttribute('placeholder')}"]`
        parts.unshift(seg)
        node = node.parentElement
      }
      return '/' + parts.join('/')
    }
    // UI 框架指纹（quillfill dom-actuator 的 class 分发）
    const FRAMEWORKS: Array<[string, string]> = [['ant-select', 'antd'], ['ant-picker', 'antd'], ['ant-cascader', 'antd'], ['el-select', 'element'], ['el-date-editor', 'element'], ['el-cascader', 'element'], ['ivu-select', 'iview'], ['ivu-date-picker', 'iview'], ['layui-form-select', 'layui'], ['mtd-select', 'mtd'], ['mtd-date-picker', 'mtd'], ['kuma-select2', 'kuma'], ['next-select', 'fusion'], ['phoenix-select', 'phoenix'], ['atsx-select', 'atsx'], ['Wdate', 'my97'], ['hc-form-control', 'angular']]
    const frameworkOf = (el: Element): string => {
      let node: Element | null = el
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const cls = node.className && typeof node.className === 'string' ? node.className : ''
        for (const [c, name] of FRAMEWORKS) if (cls.split(/\s+/).includes(c)) return name
      }
      return 'native'
    }
    // 吸顶 / 固定 / 导航栏里的文字不是表单标签（滚动后几何兜底最容易抓到它们）
    const chromeCache = new Map<Element, boolean>()
    const isChrome = (t: Element): boolean => {
      if (t.closest('header, nav, [role=banner], [role=navigation], [class*="navbar" i], [class*="nav-bar" i], [class*="topbar" i], [class*="top-bar" i], [class*="site-header" i], [class*="page-header" i], [class*="header-wrap" i]')) return true
      for (let n: Element | null = t, i = 0; n && n !== document.body && i < 12; n = n.parentElement, i++) {
        const hit = chromeCache.get(n)
        if (hit !== undefined) return hit
        let pos = ''
        try { pos = getComputedStyle(n).position } catch { /* ignore */ }
        if (pos === 'fixed' || pos === 'sticky') { chromeCache.set(n, true); return true }
      }
      return false
    }
    // 几何兜底只在同一个表单容器里找（form，或往上第一个包含 ≥3 个控件的祖先）
    const containerOf = (el: Element): Element => {
      const f = el.closest('form'); if (f) return f
      let c: Element | null = el.parentElement
      for (let i = 0; c && i < 10; i++, c = c.parentElement) if (c.querySelectorAll('input, select, textarea').length >= 3) return c
      return document.body
    }
    // 几何兜底（quillfill associateLabels）：结构上找不到标签时，取同一容器内同一行左侧最近 / 正上方最近的短文本
    const geometryLabel = (el: Element): string => {
      const r = el.getBoundingClientRect()
      if (!r.width) return ''
      const texts = Array.from(containerOf(el).querySelectorAll('label, span, div, p, td, th, dt, b, strong, h3, h4, h5, h6'))
        .filter(t => t !== el && !t.contains(el) && !t.closest('input, select, textarea, button, option, [data-career-overlay]') && t.children.length <= 2 && !t.querySelector('input, select, textarea, button') && !isChrome(t) && (() => { const it = itemOf(t); return !it || it.contains(el) })())
        .map(t => ({ t, text: clean(t.textContent), b: t.getBoundingClientRect() }))
        .filter(x => x.text && x.text.length <= 40 && x.b.width > 0 && !isGeneric(x.text))
      const sameRow = texts.filter(x => Math.abs(x.b.top - r.top) <= 14 && x.b.left + x.b.width <= r.left + 8).sort((a, b) => b.b.left - a.b.left)[0]
      const above = texts.filter(x => Math.abs(x.b.left - r.left) <= 48 && r.top - x.b.bottom >= -2 && r.top - x.b.bottom < 60).sort((a, b) => b.b.top - a.b.top)[0]
      const hit = sameRow ?? above
      if (hit) labelNode = hit.t
      return hit ? stripStar(hit.text) : ''
    }
    /** 最近的"表单项"祖先（ant-form-item / mtd-form-item / el-form-item / form-group / li / tr / fieldset）。 */
    // 飞书 formily：表单项是 ud-formily-item，或带 data-form-field-id（2026-10-31 小鹏网申表：认不出表单项，标签和必填星号全找错）
    const ITEM_RX = /(^|\s)([\w]+-)?(form-item|form-group|formitem|formily-item)(\s|$)/i
    /** 控件到它所在表单项最多隔几层：飞书 UD 的可输入下拉嵌了 9 层（小鹏「学校名称」必填星号因此没认出来）。 */
    const ITEM_DEPTH = 12
    const itemOf = (n: Element): Element | null => {
      let c: Element | null = n.parentElement
      for (let i = 0; c && c !== document.body && i < ITEM_DEPTH; i++, c = c.parentElement) {
        const cls = typeof c.className === 'string' ? c.className : ''
        if (ITEM_RX.test(cls) || c.hasAttribute('data-form-field-id') || c.tagName === 'FIELDSET' || c.tagName === 'LI' || c.tagName === 'TR') return c
      }
      return null
    }
    /** 结构上找到的标签候选：不能来自吸顶 / 导航栏，不能属于另一个表单项，且在 DOM 顺序上不晚于控件太多。 */
    const okLabelNode = (l: Element | null, el: Element): boolean => {
      if (!l || isChrome(l) || l.closest('[data-career-overlay]')) return false
      const it = itemOf(l)
      if (it && !it.contains(el)) return false
      // 别的控件外壳里的"标签样"节点（MTD 下拉的 .mtd-select-filter-label 显示的是选中值，如区号「86」）不是字段标签
      const ls = l.parentElement?.closest('.ant-select, .el-select, .ivu-select, .mtd-select, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, [class*="select" i], [class*="picker" i]')
      if (ls && !ls.contains(el) && ls.querySelector('input, select, textarea')) return false
      if (l.contains(el)) return true
      if (!(l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false
      // 标签和控件之间不能隔着别的控件（否则是上一格 / 分区标题的文字）。
      // 例外：组合控件——同一表单项里"前缀下拉 + 号码输入框"（区号 + 手机号、证件类型 + 证件号），
      // 标签属于后面的输入框；前缀下拉另起名字（见 prefixLabel）
      const elInSelect = !!selectShellOf(el)
      for (const c of controlsInDoc()) {
        if (c === el || c.contains(el)) continue
        if ((l.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) && (c.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
          if (!elInSelect && isPlainText(el) && selectShellOf(c) && it && it.contains(c)) continue
          return false
        }
      }
      return true
    }
    const KNOWN_SELECT = '.ant-select, .el-select, .ivu-select, .mtd-select, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, .ud__select'
    /** 控件所在的自定义下拉外壳：先认已知组件库的根，再退到泛 [class*=select]（MTD 输入框外还套着 mtd-select-filter-input）。 */
    /**
     * 下拉外壳：先认已知组件库；否则按结构往上取最外层带 select 的节点，遇到装着别的控件或标签的那层就停
     * （最近的那层可能只是包着搜索框的 __search，选中值渲染在它外面——2026-10-31 小鹏「学历」被读成空）。
     */
    function selectShellOf(n: Element): Element | null {
      const p = n.parentElement
      if (!p) return null
      const known = p.closest(KNOWN_SELECT)
      if (known) return known
      let shell = p.closest('[class*="select" i]')
      for (let a = shell?.parentElement ?? null; shell && a && a !== document.body && /select/i.test(typeof a.className === 'string' ? a.className : ''); a = a.parentElement) {
        const inner: Element = shell
        if (a.querySelector('label') || Array.from(a.querySelectorAll('input, select, textarea')).some(c => c !== n && !inner.contains(c))) break
        shell = a
      }
      return shell
    }
    /** 外壳里用户看得到的选中文字：去掉占位 / 提示节点和图标字符；只剩提示语（请选择…）算空。 */
    function shownText(shell: Element): string {
      let t = clean((shell as HTMLElement).innerText)
      for (const h of Array.from(shell.querySelectorAll('[class*="placeholder" i]:not(input), [class*="hint" i]'))) { const x = clean((h as HTMLElement).innerText); if (x) t = t.replace(x, '') }
      t = clean(t.replace(/[\p{So}\p{Co}×✕✖⨯⌄∨˅]/gu, ''))
      return /^(请选择|请输入|选择|搜索|please select|select|--)?$/i.test(t) ? '' : t
    }
    function isPlainText(n: Element): boolean {
      const t = ((n as HTMLInputElement).type || '').toLowerCase()
      return (n.tagName === 'INPUT' && ['', 'text', 'tel', 'email', 'number'].includes(t)) || n.tagName === 'TEXTAREA'
    }
    let controlsCache: Element[] | null = null
    const controlsInDoc = (): Element[] => controlsCache ??= Array.from(document.querySelectorAll('input:not([type=hidden]), select, textarea, [contenteditable="true"]'))
    const firstLabel = (root: Element, el: Element): string => {
      for (const l of Array.from(root.querySelectorAll(LABEL)).slice(0, 40)) { if (okLabelNode(l, el)) { const t = pure(l); if (ok(t)) { labelNode = l; return t } } }
      return ''
    }
    /** 用 CSS 伪元素（::before content）画出来的标签。 */
    const pseudoLabel = (el: Element): string => {
      const it = itemOf(el)
      if (!it) return ''
      for (const n of [it, ...Array.from(it.children)].slice(0, 5)) {
        let c = ''
        try { c = getComputedStyle(n, '::before').content } catch { /* ignore */ }
        const m = c.match(/^"(.+)"$/)
        if (m) { const t = stripStar(m[1]); if (ok(t) && t.length <= 30) return t }
      }
      return ''
    }
    let labelVia = ''
    function labelFor(el: Element): string {
      labelNode = null
      labelVia = 'aria'
      const aria = el.getAttribute('aria-label'); if (ok(aria)) return stripStar(aria!)
      const lb = el.getAttribute('aria-labelledby')
      if (lb) { const t = lb.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '); if (ok(t)) return stripStar(clean(t)) }
      // 网站自己标在控件上的字段名（飞书 data-form-field-i18n-name）：比按位置猜的标签可靠。
      // 单选 / 勾选框例外：它们的标签是选项自己的文字，整组的字段名由 groupLabel 用（2026-10-31 小鹏：三个选项都成了「推荐方式」）
      const choiceType = ((el as HTMLInputElement).type || '').toLowerCase()
      if (choiceType !== 'radio' && choiceType !== 'checkbox') {
        labelVia = 'semantic'
        const sem = el.getAttribute('data-form-field-i18n-name') || el.closest('[data-form-field-i18n-name]')?.getAttribute('data-form-field-i18n-name') || ''
        if (ok(sem)) return stripStar(clean(sem))
      }
      labelVia = 'for'
      const id = (el as HTMLElement).id
      // 问卷星把选项文字放在 <div class="label" for="q2_1"> 里：不是 <label> 也照认（2026-11-02 实测，选项拿成了题目）
      if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`) ?? document.querySelector(`[for="${CSS.escape(id)}"]`); if (l && ok(pure(l))) return pure(l) }
      const pl = el.closest('label'); if (pl && ok(pure(pl))) return pure(pl)
      labelVia = 'wrapper'
      const w = wrapperOf(el)
      if (w) { const t = firstLabel(w, el); if (t) return t }
      let c: Element | null = el.parentElement
      for (let i = 0; i < 4 && c; i++, c = c.parentElement) { const t = firstLabel(c, el); if (t) return t }
      labelVia = 'pseudo'
      const ps = pseudoLabel(el); if (ps) return ps
      labelVia = 'geometry'
      const geo = geometryLabel(el); if (ok(geo)) return geo
      labelVia = 'placeholder'
      const ph = (el as HTMLInputElement).placeholder; if (ok(ph)) return stripStar(ph)
      labelVia = 'name'
      return stripStar(ok((el as HTMLInputElement).name))
    }
    const NAV_WORD_RX = /(人才招聘|招聘官网|校园招聘|社会招聘|首页|登录|注册|个人中心|我的投递|职位搜索|关于我们|加入我们|longcat|join us|careers?$)/i
    const FIELDISH_RX = /(姓名|名称|学校|学院|专业|学历|学位|时间|日期|电话|手机|邮箱|地址|城市|证件|性别|民族|籍贯|政治|职位|岗位|公司|单位|经历|描述|成绩|排名|导师|方向|语言|水平|证书|奖项|链接|网址|作品|简历|附件|照片|期望|薪资|到岗|是否|name|school|major|degree|date|phone|email|city|title|company)/i
    const suspicious = (label: string, via: string): string => {
      if (!label) return '没有找到标签'
      if (NAV_WORD_RX.test(label) && !FIELDISH_RX.test(label)) return '标签像导航栏 / 站点名'
      if (/^[+＋]?\d+$/.test(label)) return '标签是纯数字（多半是区号前缀）'
      if (label.length > 30 && !FIELDISH_RX.test(label)) return '标签过长，像说明文字'
      if (via === 'name' && /^[a-z0-9_-]+$/i.test(label) && label.length > 18) return '只有内部字段名'
      return ''
    }
    /**
     * 单选组的外层容器（radiogroup / fieldset / *radio-group*）——只有里面没有别的字段时才算：
     * 问卷星整页包在一个 fieldset 里，拿它当组容器，每组单选都认成了第一题（2026-11-02 实测）。
     */
    function choiceGroupBox(first: Element): Element | null {
      const box = first.closest('[role=radiogroup], fieldset, [class*="radio-group" i]')
      if (!box) return null
      const name = (first as HTMLInputElement).name
      const own = (x: Element) => { const t = (x as HTMLInputElement).type; return t === 'hidden' || (t === 'radio' && (x as HTMLInputElement).name === name) }
      return Array.from(box.querySelectorAll('input, select, textarea')).every(own) ? box : null
    }
    /**
     * 藏起来的单选（display:none，旁边画一个假圆圈）真正能点的那个：它的 [for] 文字、包着它的 label，
     * 或只包着这一个选项的最小可见容器。问卷星就是这样，直接点 input 会一直等它变可见（2026-11-02 实测）。
     */
    function choiceProxy(r: Element): Element | null {
      const id = (r as HTMLElement).id
      const forEl = id ? document.querySelector(`[for="${CSS.escape(id)}"]`) : null
      if (forEl && vis(forEl)) return forEl
      const lb = r.closest('label'); if (lb && vis(lb)) return lb
      for (let a = r.parentElement, i = 0; a && i < 4; a = a.parentElement, i++) {
        if (a.querySelectorAll('input[type=radio]').length > 1) return null
        if (vis(a)) return a
      }
      return null
    }
    function groupLabel(first: Element, options: string[]): string {
      const sem = first.closest('[data-form-field-i18n-name]')?.getAttribute('data-form-field-i18n-name') || ''
      if (sem.trim()) return stripStar(clean(sem))
      const rg = choiceGroupBox(first)
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
    const REQ_CLASS_RX = /(^|\s)([\w-]*-)?(is-)?required(\s|$)|(^|\s)[\w-]*-required[\w-]*(\s|$)|(^|\s)([\w-]*-)?(star|asterisk)(\s|$)/i
    const starIn = (n: Element | null): boolean => {
      if (!n) return false
      for (const s of Array.from(n.querySelectorAll('i, em, span, b, sup, [class*="required" i], [class*="star" i], [class*="asterisk" i]')).slice(0, 12)) {
        if (s.children.length === 0 && /^[*＊]$/.test((s.textContent || '').trim())) return true
      }
      try { if (/^"[*＊]/.test(getComputedStyle(n, '::before').content) || /^"[*＊]/.test(getComputedStyle(n, '::after').content)) return true } catch { /* ignore */ }
      return /^[\s]*[*＊]/.test(clean(n.textContent)) || /[*＊][\s]*$/.test(clean(n.textContent))
    }
    const requiredOf = (el: Element): { required: boolean; via?: string } => {
      if ((el as HTMLInputElement).required) return { required: true, via: 'attr' }
      if (el.getAttribute('aria-required') === 'true') return { required: true, via: 'aria' }
      // 表单项（mtd-form-item / ant-form-item / el-form-item / form-group / li / tr / fieldset）以内：
      // 祖先 class 带 required，或表单项里的标签带 required class / 星号节点 / ::before 星号
      const item = itemOf(el)
      for (let n: Element | null = el.parentElement, i = 0; n && i < 6; n = n.parentElement, i++) {
        if (n.getAttribute('aria-required') === 'true') return { required: true, via: 'aria' }
        const cls = typeof n.className === 'string' ? n.className : ''
        if (REQ_CLASS_RX.test(cls)) return { required: true, via: 'class' }
        if (n === item || (!item && i >= 2)) break
      }
      if (item) {
        for (const l of Array.from(item.querySelectorAll(LABEL)).filter(l => !l.contains(el)).slice(0, 3)) {
          const lc = typeof l.className === 'string' ? l.className : ''
          if (REQ_CLASS_RX.test(lc)) return { required: true, via: 'class' }
          if (starIn(l)) return { required: true, via: 'star' }
        }
        if (starIn(item.firstElementChild)) return { required: true, via: 'star' }
      }
      return { required: false }
    }
    const PICKER_SEL = '[data-career-popup], [class*="dropdown" i], [class*="popper" i], [class*="popover" i], [role=listbox], [role=tree], [class*="treeselect" i], [class*="cascader-menu" i]'
    /** 控件在浮起来的下拉层里（祖先是 absolute / fixed 定位的弹层）。 */
    const inFloatingPicker = (n: Element): boolean => {
      const layer = n.closest(PICKER_SEL)
      if (!layer) return false
      for (let a: Element | null = layer; a && a !== document.body; a = a.parentElement) { const pos = getComputedStyle(a).position; if (pos === 'absolute' || pos === 'fixed') return true }
      return false
    }
    const out: RawField[] = []
    const meta: Record<string, { xpath: string; framework: string }> = {}
    const seenRadio = new Set<Element>()
    const els = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"]'))
    for (const el of els) {
      // 宿主自动收码写入的 OTP 不参与资料规划、答案记忆或模型上下文。
      if (el.getAttribute('data-career-private') === 'otp') continue
      const tag = el.tagName.toLowerCase()
      const itype = ((el as HTMLInputElement).type || '').toLowerCase()
      const role = el.getAttribute('role') || ''
      if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset'].includes(itype)) continue
      // type=search 一般是站内搜索框；但 antd Select 的输入框也是 type=search（role=combobox、在下拉外壳里），那是表单控件
      if (tag === 'input' && itype === 'search' && role !== 'combobox' && !selectShellOf(el)) continue
      const isFile = itype === 'file'
      if (!isFile && itype !== 'radio' && itype !== 'checkbox' && !vis(el)) continue
      if (el.closest('[class*="search" i][class*="box" i], [role="search"]')) continue
      // select2 / chosen 给原生 <select> 套的外壳（紧跟在 select 后面、role=combobox、没有自己的标签）：同一个字段，原生 select 已经收了。
      // 问卷星「性别」就是这样，外壳被当成一个必填的「没认出名字的字段」，挡住提交还推给用户（2026-11-02 中兵通信）
      const deco = role === 'combobox' && tag !== 'select' ? el.closest('.select2-container, .chosen-container') : null
      if (deco && deco.previousElementSibling?.tagName === 'SELECT') continue
      // 下拉 / 树选择弹层里的勾选框、搜索框是选项，不是表单字段（2026-10-31 小鹏：期望工作地点弹层没收起，9 个树节点勾选框被当成「?」字段）
      if (inFloatingPicker(el)) continue
      const name = (el as HTMLInputElement).name || (el as HTMLElement).id || undefined
      const req = requiredOf(el)
      const required = req.required
      if (itype === 'radio') {
        if (seenRadio.has(el)) continue
        const rn = (el as HTMLInputElement).name
        // 没有 name 的单选（飞书 UD）：按共同容器成组（radiogroup / fieldset / *radio-group* / 网站标的字段项），不然一组被拆成几个字段
        const box = rn ? null : el.closest('[role=radiogroup], fieldset, [class*="radio-group" i], [data-form-field-id]')
        const group = rn ? Array.from(document.querySelectorAll(`input[type=radio][name="${CSS.escape(rn)}"]`)) : box ? Array.from(box.querySelectorAll('input[type=radio]')).filter(r => !(r as HTMLInputElement).name) : [el]
        group.forEach(r => seenRadio.add(r))
        const id = idFor(el)
        meta[id] = { xpath: xpathOf(el), framework: frameworkOf(el) }
        const options = group.map(r => clean(labelFor(r) || (r as HTMLInputElement).value)).filter(Boolean)
        let value: string | undefined
        group.forEach((r, i) => {
          r.setAttribute('data-career-field', id); r.setAttribute('data-career-option', options[i] ?? String(i))
          if ((r as HTMLInputElement).checked || r.getAttribute('aria-checked') === 'true') value = options[i]
          const px = vis(r) ? null : choiceProxy(r)
          if (px) { px.setAttribute('data-career-proxy', id); px.setAttribute('data-career-proxy-option', options[i] ?? String(i)) }
        })
        out.push({ id, label: clean(groupLabel(el, options)) || rn || '', name: rn, type: 'radio', options, required, value, requiredVia: req.via })
        continue
      }
      const id = idFor(el)
      el.setAttribute('data-career-field', id)
      meta[id] = { xpath: xpathOf(el), framework: frameworkOf(el) }
      if (tag === 'select') {
        const sel = el as HTMLSelectElement
        const options = Array.from(sel.options).map(o => clean(o.textContent)).filter(o => o && !isGeneric(o))
        const cur = sel.selectedIndex >= 0 ? clean(sel.options[sel.selectedIndex]?.textContent) : ''
        const label = clean(labelFor(el))
        out.push({ id, label, name, type: 'select', options, required, value: cur && !isGeneric(cur) ? cur : undefined, requiredVia: req.via, labelUncertain: suspicious(label, labelVia) || undefined })
        continue
      }
      // 自定义下拉外壳只看祖先（antd 的隐藏搜索框自己的类名就含 "select"，不能把输入框当外壳）
      const shellAncestor = selectShellOf(el)
      if (role === 'combobox' || shellAncestor) {
        const shell = shellAncestor || el
        // 选中值的展示节点；MTD 是 .mtd-select-filter-label（没选时带 -hint 类、写"请选择"，不算值）
        const shownEl = shell === el ? null : shell.querySelector('[class*="selection-item" i], [class*="single-value" i], [class*="selected-value" i], [class*="filter-label" i]:not([class*="hint" i]), .el-input__inner, .layui-input') as HTMLElement | null
        // 展示 / 占位节点要是和输入框分开的另一个节点；包着输入框本身的那层（飞书 UD 的 __placeholder__wrapper）不算，否则输入框里的值永远读不到（小鹏「学校名称」）
        const hasLabelNode = shell !== el && Array.from(shell.querySelectorAll('[class*="filter-label" i], [class*="selection-item" i], [class*="placeholder" i]:not(input)')).some(n => !n.contains(el))
        // 认不出展示节点时，按外壳里看得到的文字读选中值（飞书 UD 等没见过的组件库）
        const shown = clean((shownEl && shownEl !== el ? ((shownEl as HTMLInputElement).value || shownEl.textContent) : '') || (hasLabelNode ? '' : (el as HTMLInputElement).value) || (shell !== el && !shownEl ? shownText(shell) : ''))
        let label = clean(labelFor(el))
        let uncertain = suspicious(label, labelVia)
        // 组合控件的前缀下拉（区号 / 证件类型）：和后面的输入框共用一个标签。标签归输入框，前缀下拉按提示文字另起名，
        // 认不出含义就标"标签可疑"（不按它填），免得把手机号写进区号下拉
        const own = labelNode as Element | null
        if (own && shell !== el) {
          const all = controlsInDoc()
          const next = all.slice(all.indexOf(el) + 1).find(c => vis(c) && !['hidden', 'checkbox', 'radio', 'file'].includes(((c as HTMLInputElement).type || '').toLowerCase()))
          if (next && isPlainText(next) && !selectShellOf(next) && !next.parentElement?.closest('[class*="picker" i], [class*="date" i]')) {
            const keepVia = labelVia
            labelFor(next)
            const shared = labelNode === own
            labelVia = keepVia; labelNode = own
            if (shared) {
              const hintEl = shell.querySelector('[class*="hint" i], [class*="placeholder" i]:not(input)')
              const hint = clean(hintEl?.textContent) || (el as HTMLInputElement).placeholder || ''
              const derived = stripStar(hint.replace(/^(请选择|请输入|选择)\s*/, ''))
              if (derived && derived.length <= 12 && !isGeneric(derived)) { label = derived; uncertain = '' }
              else if (/^[+＋]?\d{1,4}$/.test(shown)) { label = '国际区号'; uncertain = '' }
              else uncertain = `「${label}」组合控件里的前缀下拉，含义不明`
            }
          }
        }
        out.push({ id, label, name, type: 'select', options: [], required, custom: true, value: shown && !isGeneric(shown) ? shown : undefined, readonly: (el as HTMLInputElement).readOnly || undefined, requiredVia: req.via, labelUncertain: uncertain || undefined })
        continue
      }
      if (el.getAttribute('contenteditable') === 'true') {
        const label = clean(labelFor(el))
        out.push({ id, label, name, type: 'richtext', required, value: clean((el as HTMLElement).innerText) || undefined, requiredVia: req.via, labelUncertain: suspicious(label, labelVia) || undefined })
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
      const label = clean(labelFor(el))
      out.push({ id, label, name, type, required, value, maxLength: ml && ml > 0 ? ml : undefined, placeholder: (input.placeholder || "").trim() || undefined, readonly: input.readOnly || undefined, requiredVia: req.via, labelUncertain: type === 'file' || type === 'checkbox' ? undefined : suspicious(label, labelVia) || undefined })
    }
    for (const f of out) { const m = meta[f.id]; if (m) { f.xpath = m.xpath; f.framework = m.framework } }
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
    const tagged: Element[] = []
    let n = 0
    for (const b of Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]'))) {
      if (!vis(b)) continue
      const text = clean((b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute('aria-label') || b.getAttribute('title')).slice(0, 60)
      if (!text) continue
      const id = `b${n++}`
      b.setAttribute('data-career-btn', id)
      const disabled = (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true' || /(^|\s)(is-disabled|disabled)(\s|$)/.test(b.className || '')
      const rawHref = b.tagName === 'A' ? (b as HTMLAnchorElement).href : ''
      const href = /^https?:/i.test(rawHref) && rawHref.split('#')[0] !== location.href.split('#')[0] ? rawHref : undefined
      buttons.push({ id, text, selector: `[data-career-btn="${id}"]`, disabled, ...(href ? { href } : {}) })
      tagged.push(b)
      if (n >= 80) break
    }
    // 很多站的"添加一段经历"是带点击事件的 div / span（美团「添加教育经历」就是），不是 button：
    // 按行为补收——可点（手形光标 / onclick / tabindex / 按钮类名）、文字是"添加 / 新增 …"的最内层元素。
    // 北森 zhiye 岗位行就地展开后的「立即投递」也是可点 div（2026-10-31 联发科技）：申请入口同样按行为补收，
    // 点不点由 drive 的入口守卫决定（只在页面还没有网申表时点）
    // 问卷星的「提交」也是 div#ctlNext.submitbtn：最终提交按钮同样按行为补收，否则批准后找不到按钮、永远交不出去（2026-11-02 中兵通信）。
    // 收进来不等于会点：填表阶段的提交守卫一律不点提交类文案，只有他批准后的提交步骤才点它
    const ADD_RX = /^(\+|＋)?\s*(添加|新增|增加|继续添加|再添加)|^(立即投递|投递|投递简历|申请职位|立即申请|我要投递|我要申请|提交|提交申请|确认提交|提交问卷|提交报名|立即提交)$/
    const addCands = Array.from(document.querySelectorAll('div, span, p, li, i, label, em, strong')).filter(el => {
      // 只排除本次已当按钮收下的元素（上一次扫描留下的标记不算，否则第二次扫描就把它漏了）
      if (tagged.some(b => b.contains(el)) || !vis(el)) return false
      const t = clean((el as HTMLElement).innerText)
      if (!t || t.length > 16 || !ADD_RX.test(t)) return false
      const cls = typeof el.className === 'string' ? el.className : ''
      const clickable = getComputedStyle(el).cursor === 'pointer' || el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0' || /(submit|btn)/i.test(cls)
      return clickable
    })
    for (const el of addCands) {
      if (addCands.some(o => o !== el && el.contains(o))) continue
      const id = `b${n++}`
      el.setAttribute('data-career-btn', id)
      buttons.push({ id, text: clean((el as HTMLElement).innerText).slice(0, 60), selector: `[data-career-btn="${id}"]`, disabled: /(^|\s)(is-disabled|disabled)(\s|$)/.test(typeof el.className === 'string' ? el.className : '') })
      if (n >= 100) break
    }
    const errors: string[] = []
    // 校验错误要像错误：信息 / 提醒类横幅（「还可以投递 3 次」「截止说明」）不算——2026-10-31 小鹏的投递次数说明被当成了要学生处理的校验错误
    const NOTICE_CLASS_RX = /(info|notice|tips?|warn|success|hint)/i
    const ERROR_CLASS_RX = /(error|danger|invalid)/i
    const ERROR_WORD_RX = /(请|必填|不能为空|不得为空|格式|有误|错误|不正确|不合法|无效|已存在|invalid|required|error)/i
    const clsOf = (n: Element) => (typeof n.className === 'string' ? n.className : '')
    const isNotice = (e: Element): boolean => {
      for (let a: Element | null = e, i = 0; a && i < 4; a = a.parentElement, i++) { const c = clsOf(a); if (ERROR_CLASS_RX.test(c)) return false; if (NOTICE_CLASS_RX.test(c)) return true }
      return false
    }
    for (const e of Array.from(document.querySelectorAll('[aria-invalid="true"] ~ *, [role="alert"], [class*="error" i]:not([class*="clear" i]), [class*="form-item__error" i], [class*="explain-error" i]'))) {
      if (!vis(e) || isNotice(e)) continue
      const t = clean(e.textContent)
      if (e.getAttribute('role') === 'alert' && !ERROR_CLASS_RX.test(clsOf(e)) && !ERROR_WORD_RX.test(t)) continue
      if (t && t.length > 1 && t.length < 160) errors.push(t)
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

/**
 * 页内执行器（借鉴 quillfill dom-actuator）：Playwright 的 fill / selectOption 填不进去时，在页面里按 UI 框架指纹走
 * "打开下拉 → 等选项渲染 → 文本匹配 → 模拟点击 → blur"，原生控件走 React 安全赋值（原型链 setter + input/change 事件），
 * 富文本走 execCommand insertText。永远不碰提交按钮。
 */
export interface FillValueArg { selector: string; value: string; kind?: 'auto' | 'text' | 'select' | 'date' | 'richtext'; fieldKey?: string }
export interface FillValueResult { ok: boolean; strategy: string; framework: string; detail?: string }
export const fillValueScript: PageScript<FillValueArg, FillValueResult> = {
  id: SCRIPT_IDS.fillValue,
  fn: async ({ selector, value, kind, fieldKey }) => {
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return { ok: false, strategy: 'none', framework: 'native', detail: '元素不存在' }
    const norm = (s: string | null | undefined) => (s || '').replace(/[\s*＊:：（）()]/g, '').toLowerCase()
    const want = norm(value)
    const visible = (n: Element) => { const h = n as HTMLElement; if (h.offsetParent !== null) return true; try { return getComputedStyle(h).position === 'fixed' } catch { return false } }
    const setNative = (input: HTMLInputElement | HTMLTextAreaElement, v: string) => {
      const proto = Object.getPrototypeOf(input)
      const protoSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      const ctorSet = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set
      if (protoSet && protoSet !== ctorSet) protoSet.call(input, v)
      else if (ctorSet) ctorSet.call(input, v)
      else input.value = v
    }
    const fire = (n: Element, types: string[]) => { for (const t of types) n.dispatchEvent(new Event(t, { bubbles: true, cancelable: true })) }
    const click = async (n: Element, pre = 0) => {
      if (pre) await sleep(pre)
      if (typeof PointerEvent === 'function') { n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1 })); }
      n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      if (typeof PointerEvent === 'function') n.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }))
      n.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      n.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await sleep(20)
    }
    const enter = (n: Element) => { for (const t of ['keydown', 'keypress', 'keyup']) n.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })) }
    const typeNative = async (input: HTMLInputElement | HTMLTextAreaElement, v: string, blur = true) => {
      input.focus({ preventScroll: true }); fire(input, ['focus']); await sleep(10)
      setNative(input, v); input.setAttribute('value', v)
      fire(input, ['input', 'change'])
      if (blur) { fire(input, ['blur']); input.blur() }
    }
    const ancestor = (n: Element | null, cls: string): HTMLElement | null => { while (n && (n as HTMLElement).classList) { if ((n as HTMLElement).classList.contains(cls)) return n as HTMLElement; n = n.parentElement } return null }
    const waitFor = async <T,>(fn: () => T | null, tries = 12, interval = 150): Promise<T | null> => { for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; await sleep(interval) } return null }
    /** 在候选选项里找文本：精确 → 包含（最短）。 */
    const pickOption = (nodes: Element[]): Element | null => {
      const vis = nodes.filter(visible)
      const texts = vis.map(n => ({ n, t: norm(n.textContent) }))
      return texts.find(x => x.t === want)?.n ?? texts.filter(x => x.t && (x.t.includes(want) || (want.length >= 2 && want.includes(x.t)))).sort((a, b) => a.t.length - b.t.length)[0]?.n ?? null
    }
    const q = (sel: string) => Array.from(document.querySelectorAll(sel))

    // ---- 框架适配器：返回 true 表示已选中 ----
    type Adapter = { name: string; framework: string; match: () => boolean; run: () => Promise<boolean> }
    const dropdown = (framework: string, shellCls: string, triggerSel: string | null, optionSel: string): Adapter => ({
      name: `${framework}-select`, framework,
      match: () => !!ancestor(el, shellCls),
      run: async () => {
        const root = ancestor(el, shellCls)!
        await click((triggerSel && root.querySelector(triggerSel)) || root, 60)
        const opt = await waitFor(() => pickOption(q(optionSel)))
        if (!opt) { fire(root, ['blur']); await click(document.body, 10); return false }
        await click(opt)
        fire(el, ['blur'])
        return true
      },
    })
    const datePicker = (framework: string, shellCls: string): Adapter => ({
      name: `${framework}-date`, framework,
      match: () => !!ancestor(el, shellCls),
      run: async () => {
        const root = ancestor(el, shellCls)!
        const input = (root.querySelector('input') as HTMLInputElement | null) ?? (el as HTMLInputElement)
        await click(input, 60); await sleep(150)
        await typeNative(input, value, false)
        enter(input); await sleep(120)
        const okBtn = document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-ok button, .el-picker-panel__footer .el-button--default:last-child')
        if (okBtn && visible(okBtn)) await click(okBtn)
        fire(input, ['blur']); await click(document.body, 10)
        return norm(input.value) === want || norm(input.value).startsWith(want.slice(0, 6))
      },
    })
    const adapters: Adapter[] = [
      dropdown('antd', 'ant-select', '.ant-select-selector', '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .ant-select-dropdown:not(.ant-select-dropdown-hidden) li'),
      datePicker('antd', 'ant-picker'),
      dropdown('antd', 'ant-cascader-picker', null, '.ant-cascader-menu-item'),
      dropdown('element', 'el-select', 'input', '.el-select-dropdown__item'),
      datePicker('element', 'el-date-editor'),
      dropdown('element', 'el-cascader', null, '.el-cascader-node'),
      dropdown('iview', 'ivu-select', '.ivu-select-selection', '.ivu-select-dropdown li'),
      datePicker('iview', 'ivu-date-picker'),
      dropdown('layui', 'layui-form-select', null, '.layui-anim dl dd'),
      dropdown('mtd', 'mtd-select', null, '.mtd-select-dropdown li, .mtd-option'),
      datePicker('mtd', 'mtd-date-picker'),
      dropdown('kuma', 'kuma-select2', null, '.kuma-select2-dropdown li'),
      dropdown('fusion', 'next-select', null, '.next-menu-item'),
      dropdown('phoenix', 'phoenix-select', null, '.phoenix-select-dropdown li, [class*="phoenix-select"] li'),
      dropdown('atsx', 'atsx-select', null, '[class*="atsx-select-dropdown"] li, [class*="atsx-select-item"]'),
      datePicker('atsx', 'atsx-date-picker'),
      { name: 'my97-date', framework: 'my97', match: () => el.classList.contains('Wdate'), run: async () => { const input = el as HTMLInputElement; input.focus(); await sleep(200); await typeNative(input, value, false); enter(input); await sleep(150); const frame = q('iframe').find(f => { try { return !!(f as HTMLIFrameElement).contentDocument?.getElementById('dpOkInput') } catch { return false } }) as HTMLIFrameElement | undefined; const okBtn = frame?.contentDocument?.getElementById('dpOkInput'); if (okBtn) okBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); input.blur(); return norm(input.value) === want } },
      // 通用自定义下拉（role=combobox / aria-haspopup）：点开 → 找任何可见 option / li
      { name: 'generic-combobox', framework: 'generic', match: () => el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox' || !!el.closest('[class*="select" i]'), run: async () => {
        await click(el, 60)
        const opt = await waitFor(() => pickOption(q('[role="option"], [role="listbox"] li, [class*="dropdown" i] li, [class*="option" i]').filter(n => !el.contains(n))))
        if (!opt) { await click(document.body, 10); return false }
        await click(opt); fire(el, ['blur']); return true
      } },
    ]
    const framework = adapters.find(a => a.match())?.framework ?? 'native'
    const wantsWidget = kind === 'select' || kind === 'date' || (kind !== 'text' && kind !== 'richtext' && framework !== 'native')
    if (wantsWidget) {
      for (const a of adapters) {
        if (!a.match()) continue
        try { if (await a.run()) return { ok: true, strategy: a.name, framework } } catch (e) { /* 下一个适配器 */ void e }
      }
    }
    // ---- 原生兜底 ----
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') {
      const sel = el as HTMLSelectElement
      const opts = Array.from(sel.options)
      const idx = opts.findIndex(o => norm(o.textContent) === want || norm(o.value) === want)
      const idx2 = idx >= 0 ? idx : opts.map((o, i) => ({ i, t: norm(o.textContent) })).filter(x => x.t && (x.t.includes(want) || want.includes(x.t))).sort((a, b) => a.t.length - b.t.length)[0]?.i ?? -1
      if (idx2 < 0) return { ok: false, strategy: 'native-select', framework, detail: `选项里没有「${value}」` }
      sel.selectedIndex = idx2; fire(sel, ['input', 'change'])
      return { ok: true, strategy: 'native-select', framework }
    }
    if (tag === 'input' || tag === 'textarea') {
      const input = el as HTMLInputElement
      if (input.type === 'checkbox' || input.type === 'radio') { if (!input.checked) await click(input); return { ok: input.checked, strategy: 'native-check', framework } }
      // 第二重：原型链 setter 只给普通可编辑文本框。只读 / combobox / 自定义下拉外壳里的展示框写进去只是"看起来有值"，
      // 框架的数据模型并没有变（以前在这里读回相同就报成功，就是"学历 ← native-input"的假成功）
      const inWidget = !!el.parentElement?.closest('.ant-select, .ant-picker, .ant-cascader, .el-select, .el-date-editor, .el-cascader, .ivu-select, .ivu-date-picker, .mtd-select, .mtd-picker, .mtd-date-picker, .mtd-cascader, .next-select, .kuma-select2, .layui-form-select, .phoenix-select, .atsx-select, [class*="select" i], [class*="picker" i], [class*="cascader" i]')
      if (input.readOnly || input.disabled || el.getAttribute('role') === 'combobox' || inWidget) return { ok: false, strategy: 'refused', framework, detail: '只读或自定义控件，不用原生赋值' }
      await typeNative(input, value)
      if (/school|major|学校|院校|专业|city|城市/i.test(fieldKey || '')) await click(document.body, 20) // 收起联想下拉
      return { ok: norm(input.value) === want, strategy: 'native-input', framework, detail: norm(input.value) === want ? undefined : `读回「${input.value}」` }
    }
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      el.focus({ preventScroll: true })
      try { document.execCommand('selectAll', false); document.execCommand('insertText', false, value) } catch { el.textContent = value }
      fire(el, ['input'])
      return { ok: norm(el.textContent) === want, strategy: 'contenteditable', framework }
    }
    return { ok: false, strategy: 'none', framework, detail: `不支持的元素 ${tag}` }
  },
}
