import type { Page } from 'playwright-core'
import { basename } from 'node:path'
import { SCRIPT_IDS, type PageScript, type RawField, type PageSignals, type ButtonInfo, type FieldType } from './scripts.js'
import { WIDGET_SCRIPT_IDS, type DialogInfo } from './widgets.js'

/**
 * PageLike：引擎只依赖这个最小接口。真实实现由 fromPlaywright 适配 playwright-core 的 Page；
 * 测试用 FakePage（内存 DOM 模型）。浏览器本身由 shell 的 browser-host 托管，这里不启动浏览器。
 */
export interface LocatorLike {
  fill(value: string): Promise<void>
  click(): Promise<void>
  selectOption(value: string | { label: string }): Promise<unknown>
  setInputFiles(files: string | string[]): Promise<void>
  count(): Promise<number>
  innerText(): Promise<string>
  isVisible(): Promise<boolean>
  first(): LocatorLike
}

export interface KeyboardLike {
  type(text: string, opts?: { delay?: number }): Promise<void>
  press(key: string): Promise<void>
}
/** 坐标操作（视觉兜底层用）：视口 CSS 像素。 */
export interface MouseLike {
  click(x: number, y: number): Promise<void>
  move?(x: number, y: number): Promise<void>
}

export interface PageLike {
  goto(url: string): Promise<void>
  url(): string
  title(): Promise<string>
  content(): Promise<string>
  evaluate<A, R>(script: PageScript<A, R>, arg?: A): Promise<R>
  fill(selector: string, value: string): Promise<void>
  click(selector: string): Promise<void>
  selectOption(selector: string, value: string | { label: string }): Promise<void>
  setInputFiles(selector: string, files: string | string[]): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  screenshot(): Promise<Uint8Array>
  /** 遥测用的小截图（低质量、CSS 像素）；没有就用 screenshot。 */
  screenshotSmall?(): Promise<Uint8Array>
  locator(selector: string): LocatorLike
  keyboard?: KeyboardLike
  /** 没有 mouse 的实现无法走视觉兜底层。 */
  mouse?: MouseLike
  viewportSize?(): Promise<{ width: number; height: number } | null>
}

/** 把 playwright-core 的 Page 适配成 PageLike。未在真实登录态下的国内站验证。 */
export function fromPlaywright(page: Page): PageLike {
  const wrapLocator = (loc: ReturnType<Page['locator']>): LocatorLike => ({
    fill: v => loc.fill(v),
    click: () => loc.click({ timeout: 8000 }),
    selectOption: v => loc.selectOption(v as string),
    setInputFiles: f => loc.setInputFiles(f),
    count: () => loc.count(),
    innerText: () => loc.innerText(),
    isVisible: () => loc.isVisible(),
    first: () => wrapLocator(loc.first()),
  })
  return {
    goto: async url => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {}) },
    url: () => page.url(),
    title: () => page.title(),
    content: () => page.content(),
    evaluate: <A, R>(script: PageScript<A, R>, arg?: A) => (page.evaluate as unknown as (fn: unknown, arg: unknown) => Promise<R>)(script.fn, arg),
    fill: (s, v) => page.fill(s, v, { timeout: 8000 }),
    click: s => page.click(s, { timeout: 8000 }),
    selectOption: async (s, v) => { await page.selectOption(s, v as string) },
    setInputFiles: (s, f) => page.setInputFiles(s, f),
    waitForTimeout: ms => page.waitForTimeout(ms),
    screenshot: () => page.screenshot({ type: 'jpeg', quality: 45 }),
    screenshotSmall: () => page.screenshot({ type: 'jpeg', quality: 30, scale: 'css', timeout: 5000 }),
    locator: s => wrapLocator(page.locator(s)),
    keyboard: { type: (t, o) => page.keyboard.type(t, o), press: k => page.keyboard.press(k) },
    mouse: { click: (x, y) => page.mouse.click(x, y), move: (x, y) => page.mouse.move(x, y, { steps: 8 }) },
    viewportSize: async () => page.viewportSize(),
  }
}

// ---------------------------------------------------------------------------
// FakePage：内存 DOM 模型，用于单元测试。
// 能力：预置多页表单字段 / 按钮（下一步跳转、提交按钮）/ 验证码与登录墙 / 上传回显与解析自动填充；
// 记录所有填写动作；按脚本 id 回答 extractFields / pageSignals / scrollBy。
// ---------------------------------------------------------------------------

export interface FakeFieldSpec {
  label: string
  name?: string
  type?: FieldType
  options?: string[]
  required?: boolean
  value?: string
  maxLength?: number
  placeholder?: string
  /** 视口内包围盒 [x, y, w, h]（视觉兜底层用 mouse.click 命中）。 */
  box?: [number, number, number, number]
  /** DOM 抽取看不到它（模拟 canvas / 跨域 iframe / 自绘控件），但仍可被坐标点击 + 键盘输入。 */
  domHidden?: boolean
  /** page.fill 对它无效（模拟吞掉程序化输入的自定义组件），只有逐字键入 / 页内执行器（原型链 setter）才生效。 */
  rejectFill?: boolean
  /** 页内执行器也填不进去（模拟完全自绘的控件），只剩视觉层。 */
  actuatorFails?: boolean
  /** UI 框架指纹（给 RawField.framework）。 */
  framework?: string
  /** 只读展示框（自定义下拉 / 日期面板）。 */
  readonly?: boolean
  /** 自定义下拉：点了选项也不生效（模拟永远选不中的控件）。 */
  neverSelects?: boolean
  /** 抽取脚本标出的可疑标签原因。 */
  labelUncertain?: string
}
/** 弹窗（模态 / 横幅）。modal 时挡住所有点击；点 dismissBy 里的按钮（缺省任意按钮）后消失。 */
export interface FakeDialogSpec { text: string; buttons: string[]; modal?: boolean; cookie?: boolean; afterUpload?: boolean; dismissBy?: string[] }
export interface FakeButtonSpec {
  text: string; goto?: string; submit?: boolean; disabled?: boolean; box?: [number, number, number, number]; domHidden?: boolean
  /** "添加一行"类按钮：点击后在当前页追加这些字段（模拟重复分区）。 */
  addFields?: FakeFieldSpec[]
  /** 提交类按钮：点击后站点报这些校验错误（不跳转）。 */
  submitErrors?: string[]
}
export interface FakePageSpec {
  url: string
  title?: string
  viewport?: { width: number; height: number }
  /** 页面可见文本。 */
  text?: string
  fields?: FakeFieldSpec[]
  buttons?: Array<string | FakeButtonSpec>
  /** 出现验证码 / 滑块。 */
  captcha?: boolean
  /** 登录墙（有密码框）。 */
  login?: boolean
  /** 可见的校验错误。 */
  errors?: string[]
  /** 上传文件后页面追加的回显文本（如“简历解析完成”）。 */
  uploadEcho?: string | ((file: string) => string)
  /** 上传后"解析简历"自动填充：label → value。 */
  uploadAutofill?: Record<string, string>
  /** 弹窗：afterUpload 的在上传后出现，其余一开始就在。 */
  dialogs?: FakeDialogSpec[]
  /** 页面上可见的必填星号数（缺省 = 必填字段数）。 */
  requiredMarkers?: number
  /** 组件库指纹。 */
  libraries?: string[]
}

interface LiveField extends Required<Pick<FakeFieldSpec, 'label' | 'type' | 'required'>> { id: string; name?: string; options?: string[]; value?: string; maxLength?: number; placeholder?: string; files?: string[]; box?: [number, number, number, number]; domHidden?: boolean; rejectFill?: boolean; actuatorFails?: boolean; framework?: string; readonly?: boolean; neverSelects?: boolean; labelUncertain?: string }
interface LiveDialog { id: string; spec: FakeDialogSpec; visible: boolean }
interface LivePage { spec: FakePageSpec; fields: LiveField[]; buttons: Array<FakeButtonSpec & { id: string }>; captcha: boolean; login: boolean; extraText: string; errors: string[]; scrollY: number; dialogs: LiveDialog[] }

export interface FakeAction { kind: 'goto' | 'fill' | 'click' | 'select' | 'upload' | 'type' | 'press' | 'scroll' | 'screenshot' | 'mouse' | 'dialog' | 'option'; target?: string; value?: string }

const inBox = (b: [number, number, number, number] | undefined, x: number, y: number) => !!b && x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]

const FIELD_SEL = /^\[data-career-field="([^"]+)"\](?:\[data-career-option="([^"]*)"\])?$/
const DLG_SEL = /^\[data-career-dlg-btn="d(\d+)b(\d+)"\]$/
const TEXTLIKE = new Set(['text', 'email', 'tel', 'number', 'date', 'textarea', 'richtext'])
const BTN_SEL = /^\[data-career-btn="([^"]+)"\]$/
const SUBMITISH = /提交|投递|submit|apply now/i

export class FakePage {
  readonly actions: FakeAction[] = []
  /** 是否有提交按钮被点击过（测试断言永远为 false）。 */
  submitted = false
  screenshots = 0
  readonly visited: string[] = []
  private pages = new Map<string, LivePage>()
  private current: LivePage
  private focused: LiveField | null = null
  private selectedAll = false
  private openField: LiveField | null = null
  /** 用户（测试）看到的弹窗点击记录：按钮文案。 */
  readonly dialogChoices: string[] = []
  keyboard: KeyboardLike
  mouse: MouseLike

  constructor(specs: FakePageSpec | FakePageSpec[]) {
    const list = Array.isArray(specs) ? specs : [specs]
    if (!list.length) throw new Error('FakePage 至少需要一页')
    for (const s of list) this.pages.set(s.url, materialize(s))
    this.current = this.pages.get(list[0].url)!
    this.visited.push(this.current.spec.url)
    this.keyboard = {
      type: async text => {
        this.actions.push({ kind: 'type', target: this.focused?.id, value: text })
        if (!this.focused) return
        if (this.selectedAll) { this.focused.value = ''; this.selectedAll = false }
        this.focused.value = (this.focused.value ?? '') + text
      },
      press: async key => {
        this.actions.push({ kind: 'press', target: this.focused?.id, value: key })
        if (/^(Meta|Control)\+A$/i.test(key)) this.selectedAll = true
        else if (key === 'Backspace' && this.focused) { this.focused.value = this.selectedAll ? '' : (this.focused.value ?? '').slice(0, -1); this.selectedAll = false }
        else if (key === 'Enter' && this.focused?.type === 'select' && this.focused.options?.length) { const hit = matchOption(this.focused.options, this.focused.value ?? ''); if (hit) this.focused.value = hit }
      },
    }
    // 坐标点击：按包围盒命中字段 / 按钮（视觉兜底层）
    this.mouse = {
      click: async (x, y) => {
        this.actions.push({ kind: 'mouse', value: `${x},${y}` })
        const button = this.current.buttons.find(b => inBox(b.box, x, y))
        if (button) return this.pressButton(button)
        const field = this.current.fields.find(f => inBox(f.box, x, y))
        if (!field) return
        this.focused = field; this.selectedAll = false
        if (field.type === 'checkbox') field.value = field.value === 'true' ? 'false' : 'true'
      },
    }
  }
  async viewportSize(): Promise<{ width: number; height: number }> { return this.current.spec.viewport ?? { width: 1280, height: 800 } }

  /** 让当前页突然出现验证码（模拟填到一半触发风控）。 */
  injectCaptcha(): void { this.current.captcha = true }
  injectLoginWall(): void { this.current.login = true }
  /** 当前页某字段的值（按 label 或 id）。 */
  valueOf(labelOrId: string): string | undefined { return this.findField(labelOrId)?.value }
  fieldValues(): Record<string, string | undefined> { return Object.fromEntries(this.current.fields.map(f => [f.label, f.value])) }

  async goto(url: string): Promise<void> {
    const p = this.pages.get(url)
    if (!p) throw new Error(`FakePage: 未预置的页面 ${url}`)
    this.current = p; this.focused = null
    this.visited.push(url)
    this.actions.push({ kind: 'goto', target: url })
  }
  url(): string { return this.current.spec.url }
  async title(): Promise<string> { return this.current.spec.title ?? '' }
  async content(): Promise<string> { return `<html><title>${this.current.spec.title ?? ''}</title><body>${this.bodyText()}</body></html>` }

  async evaluate<A, R>(script: PageScript<A, R>, arg?: A): Promise<R> {
    switch (script.id) {
      case SCRIPT_IDS.extractFields: return this.current.fields.filter(f => !f.domHidden).map(f => ({ id: f.id, label: f.label, name: f.name, type: f.type, options: f.framework && f.type === 'select' ? [] : f.options, required: f.required, value: f.value, maxLength: f.maxLength, placeholder: f.placeholder, custom: f.framework && f.type === 'select' ? true : undefined, xpath: `/html/body/form/${f.type}[${f.id}]`, framework: f.framework ?? 'native', readonly: f.readonly, labelUncertain: f.labelUncertain, requiredVia: f.required ? 'attr' : undefined } satisfies RawField)) as unknown as R
      case SCRIPT_IDS.fillValue: {
        // 页内执行器：原型链 setter 能绕过 rejectFill（React 受控组件）；actuatorFails 模拟完全自绘控件
        const a = arg as unknown as { selector: string; value: string; kind?: string }
        const { field } = this.resolve(a.selector)
        this.actions.push({ kind: 'fill', target: field?.id ?? a.selector, value: `actuator:${a.value}` })
        if (!field) return { ok: false, strategy: 'none', framework: 'native', detail: '元素不存在' } as unknown as R
        if (field.actuatorFails) return { ok: false, strategy: 'native-input', framework: field.framework ?? 'native', detail: '读回为空' } as unknown as R
        if (field.readonly || (field.type === 'select' && field.framework)) return { ok: false, strategy: 'refused', framework: field.framework ?? 'native', detail: '只读或自定义控件' } as unknown as R
        if (field.type === 'select') {
          const hit = matchOption(field.options ?? [], a.value)
          if (!hit) return { ok: false, strategy: `${field.framework ?? 'native'}-select`, framework: field.framework ?? 'native', detail: '选项不存在' } as unknown as R
          field.value = hit
          return { ok: true, strategy: `${field.framework ?? 'native'}-select`, framework: field.framework ?? 'native' } as unknown as R
        }
        field.value = field.maxLength ? a.value.slice(0, field.maxLength) : a.value
        return { ok: true, strategy: field.framework && field.framework !== 'native' ? `${field.framework}-date` : 'native-input', framework: field.framework ?? 'native' } as unknown as R
      }
      case SCRIPT_IDS.pageSignals: return this.signals() as unknown as R
      case SCRIPT_IDS.scrollBy: { this.current.scrollY += Number(arg ?? 0); this.actions.push({ kind: 'scroll', value: String(arg) }); return this.current.scrollY as unknown as R }
      case SCRIPT_IDS.domBoxes: {
        const boxes: Array<{ kind: string; text: string; x: number; y: number; w: number; h: number }> = []
        for (const f of this.current.fields) if (!f.domHidden && f.box) {
          boxes.push({ kind: f.type === 'checkbox' ? 'checkbox' : f.type === 'radio' ? 'radio' : f.type === 'select' ? 'select' : 'input', text: f.placeholder ?? '', x: f.box[0], y: f.box[1], w: f.box[2], h: f.box[3] })
          boxes.push({ kind: 'text', text: f.label, x: Math.max(0, f.box[0] - 110), y: f.box[1] + 4, w: 100, h: 24 })
        }
        for (const b of this.current.buttons) if (!b.domHidden && b.box) boxes.push({ kind: 'button', text: b.text, x: b.box[0], y: b.box[1], w: b.box[2], h: b.box[3] })
        return boxes as unknown as R
      }
      case SCRIPT_IDS.elementAt: {
        const { x, y } = arg as unknown as { x: number; y: number }
        const f = this.current.fields.find(f => inBox(f.box, x, y)); if (f) return { tag: f.type === 'select' ? 'select' : 'input', type: f.type, label: f.label } as unknown as R
        const b = this.current.buttons.find(b => inBox(b.box, x, y)); if (b) return { tag: 'button', label: b.text } as unknown as R
        return null as unknown as R
      }
      case WIDGET_SCRIPT_IDS.focusField: case WIDGET_SCRIPT_IDS.clearHighlight: case WIDGET_SCRIPT_IDS.maskSensitive: case WIDGET_SCRIPT_IDS.closePopup:
        return (script.id === WIDGET_SCRIPT_IDS.focusField ? { ok: !!this.resolve((arg as unknown as { selector: string }).selector).field } : true) as unknown as R
      case WIDGET_SCRIPT_IDS.prepareEntryClick: return { ok: true } as unknown as R
      case WIDGET_SCRIPT_IDS.probeTarget: {
        const { field } = this.resolve((arg as unknown as { selector: string }).selector)
        if (!field) return { exists: false } as unknown as R
        const modal = this.modalOpen()
        const editable = TEXTLIKE.has(field.type) && !field.readonly && !(field.type === 'select')
        return { exists: true, visible: true, editable, readonly: !!field.readonly, tag: field.type === 'select' && !field.framework ? 'select' : 'input', inShell: !!field.framework, blocked: modal, overlay: modal, blocker: modal ? { tag: 'div', cls: 'mtd-modal-mask', text: '' } : undefined } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.scanDialogs: {
        const dialogs: DialogInfo[] = this.current.dialogs.filter(d => d.visible).map((d, i) => ({ id: `d${i}`, text: d.spec.text, modal: d.spec.modal !== false, kind: d.spec.cookie ? 'cookie' : 'dialog', buttons: d.spec.buttons.map((t, j) => ({ id: `d${this.current.dialogs.indexOf(d)}b${j}`, text: t, selector: `[data-career-dlg-btn="d${this.current.dialogs.indexOf(d)}b${j}"]` })) }))
        return { dialogs, mask: dialogs.some(d => d.modal) } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.openOptions: {
        const { field } = this.resolve((arg as unknown as { selector: string }).selector)
        if (!field || field.actuatorFails || !field.options?.length) return { opened: false, options: [], searchable: false, cascade: false } as unknown as R
        this.actions.push({ kind: 'click', target: field.id, value: 'open' })
        this.openField = field
        return { opened: true, options: field.options.map((t, i) => ({ id: `o${i}`, text: t })), searchable: false, cascade: false } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.pickOption: {
        const a = arg as unknown as { selector: string; optId: string }
        const { field } = this.resolve(a.selector)
        const text = field?.options?.[Number(a.optId.replace(/\D/g, ''))]
        if (!field || text === undefined) return { ok: false, display: '' } as unknown as R
        this.actions.push({ kind: 'option', target: field.id, value: text })
        if (!field.neverSelects) field.value = text
        this.openField = null
        return { ok: true, display: field.value ?? '', stillOpen: false } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.readDisplay: {
        const { field } = this.resolve((arg as unknown as { selector: string }).selector)
        return { exists: !!field, display: field?.value ?? '' } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.datePick: {
        const a = arg as unknown as { selector: string; text: string }
        const { field } = this.resolve(a.selector)
        if (!field || field.actuatorFails || field.neverSelects) return { ok: false, display: field?.value ?? '', strategy: 'none', steps: 0 } as unknown as R
        field.value = a.text
        this.actions.push({ kind: 'fill', target: field.id, value: `date:${a.text}` })
        return { ok: true, display: a.text, strategy: field.readonly ? 'panel' : 'typed', steps: 1 } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.activeEditable: {
        const f = this.focused
        const a = (arg as unknown as { selector?: string; x?: number; y?: number } | undefined) ?? {}
        const editable = !!f && TEXTLIKE.has(f.type) && !f.readonly
        const isTarget = a.selector ? !!f && this.resolve(a.selector).field === f : typeof a.x === 'number' ? !!f && inBox(f.box, a.x, a.y ?? 0) : true
        return { editable, isTarget, tag: f ? 'input' : 'body' } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.pageSelection: {
        const whole = this.selectedAll && !this.focused
        if (whole && (arg as unknown as { collapse?: boolean } | undefined)?.collapse) this.selectedAll = false
        return { chars: whole ? 1000 : 0, whole, collapsed: whole } as unknown as R
      }
      case WIDGET_SCRIPT_IDS.libraryFingerprint: return (this.current.spec.libraries ?? []) as unknown as R
      case WIDGET_SCRIPT_IDS.formStats: return { markers: this.current.spec.requiredMarkers ?? this.current.fields.filter(f => f.required).length, controls: this.current.fields.length } as unknown as R
      case WIDGET_SCRIPT_IDS.domSnippet: return '<div class="fake">…</div>' as unknown as R
      default: throw new Error(`FakePage 不支持脚本 ${script.id}`)
    }
  }

  async fill(selector: string, value: string): Promise<void> {
    const { field } = this.resolve(selector)
    if (!field) throw new Error(`FakePage: fill 找不到字段 ${selector}`)
    if (field.type === 'file') throw new Error('FakePage: 文件字段请用 setInputFiles')
    this.focused = field; this.selectedAll = false
    this.actions.push({ kind: 'fill', target: field.id, value })
    if (field.rejectFill) return // 自定义组件吞掉程序化输入
    if (field.type === 'select') { const hit = matchOption(field.options ?? [], value); if (!hit) throw new Error(`FakePage: 选项不存在 ${value}`); field.value = hit }
    else if (field.type === 'checkbox') field.value = /^(true|1|yes|是)$/i.test(value) ? 'true' : 'false'
    else field.value = field.maxLength ? value.slice(0, field.maxLength) : value
  }
  async click(selector: string): Promise<void> {
    const dm = selector.match(DLG_SEL)
    if (dm) {
      const d = this.current.dialogs[Number(dm[1])]
      const text = d?.spec.buttons[Number(dm[2])]
      if (!d || !d.visible || text === undefined) throw new Error(`FakePage: 弹窗按钮不存在 ${selector}`)
      this.actions.push({ kind: 'dialog', target: d.spec.text, value: text })
      this.dialogChoices.push(text)
      if (!d.spec.dismissBy || d.spec.dismissBy.includes(text)) d.visible = false
      return
    }
    if (this.modalOpen()) throw new Error('locator.click: Timeout 8000ms exceeded.\n  - <div class="mtd-modal-mask"></div> from <div class="mtd-modal-wrapper">…</div> subtree intercepts pointer events')
    const { field, option, button } = this.resolve(selector)
    if (button) return this.pressButton(button)
    if (!field) throw new Error(`FakePage: click 找不到 ${selector}`)
    this.focused = field
    this.actions.push({ kind: 'click', target: field.id, value: option })
    if (field.type === 'radio' && option !== undefined) { const hit = matchOption(field.options ?? [], option); if (!hit) throw new Error(`FakePage: 单选项不存在 ${option}`); field.value = hit }
    else if (field.type === 'checkbox') field.value = field.value === 'true' ? 'false' : 'true'
  }
  async selectOption(selector: string, value: string | { label: string }): Promise<void> {
    const { field } = this.resolve(selector)
    if (!field || field.type !== 'select') throw new Error(`FakePage: selectOption 找不到下拉 ${selector}`)
    const want = typeof value === 'string' ? value : value.label
    const hit = matchOption(field.options ?? [], want)
    if (!hit) throw new Error(`FakePage: 选项不存在 ${want}`)
    field.value = hit
    this.actions.push({ kind: 'select', target: field.id, value: hit })
  }
  async setInputFiles(selector: string, files: string | string[]): Promise<void> {
    let field = this.resolve(selector).field
    if (!field && selector === 'input[type=file]') field = this.current.fields.find(f => f.type === 'file') ?? null
    if (!field || field.type !== 'file') throw new Error(`FakePage: 找不到文件字段 ${selector}`)
    const list = (Array.isArray(files) ? files : [files]).map(f => basename(f))
    field.files = list; field.value = list.join(', ')
    this.actions.push({ kind: 'upload', target: field.id, value: list.join(', ') })
    const echo = this.current.spec.uploadEcho
    if (echo) this.current.extraText += ' ' + (typeof echo === 'function' ? echo(list[0]) : echo)
    for (const [label, v] of Object.entries(this.current.spec.uploadAutofill ?? {})) { const f = this.findField(label); if (f) f.value = v }
    for (const d of this.current.dialogs) if (d.spec.afterUpload) d.visible = true
  }
  /** 当前页有没有挡住点击的模态弹窗。 */
  modalOpen(): boolean { return this.current.dialogs.some(d => d.visible && d.spec.modal !== false) }
  /** 测试用：弹出一个弹窗。 */
  showDialog(spec: FakeDialogSpec): void { this.current.dialogs.push({ id: `d${this.current.dialogs.length}`, spec, visible: true }) }
  async waitForTimeout(_ms: number): Promise<void> { /* 测试里不真的等 */ }
  async screenshot(): Promise<Uint8Array> { this.screenshots++; this.actions.push({ kind: 'screenshot' }); return new TextEncoder().encode(`fake-screenshot:${this.url()}`) }
  locator(selector: string): LocatorLike {
    const self = this
    const loc: LocatorLike = {
      fill: v => self.fill(selector, v),
      click: () => self.click(selector),
      selectOption: v => self.selectOption(selector, v),
      setInputFiles: f => self.setInputFiles(selector, f),
      count: async () => { const r = self.resolve(selector); return r.field || r.button ? 1 : 0 },
      innerText: async () => { const r = self.resolve(selector); return r.button?.text ?? r.field?.value ?? '' },
      isVisible: async () => { const r = self.resolve(selector); return !!(r.field || r.button) },
      first: () => loc,
    }
    return loc
  }

  // ---- 内部 ----
  private findField(labelOrId: string): LiveField | null { return this.current.fields.find(f => f.id === labelOrId || f.label === labelOrId || f.name === labelOrId) ?? null }
  private resolve(selector: string): { field: LiveField | null; option?: string; button: (FakeButtonSpec & { id: string }) | null } {
    const m = selector.match(FIELD_SEL)
    if (m) return { field: this.current.fields.find(f => f.id === m[1]) ?? null, option: m[2] === undefined ? undefined : unescapeAttr(m[2]), button: null }
    const b = selector.match(BTN_SEL)
    if (b) return { field: null, button: this.current.buttons.find(x => x.id === b[1]) ?? null }
    const t = selector.match(/^text=(.+)$/) || selector.match(/:has-text\("([^"]+)"\)/)
    if (t) return { field: null, button: this.current.buttons.find(x => x.text.includes(t[1])) ?? null }
    return { field: null, button: null }
  }
  private async pressButton(button: FakeButtonSpec & { id: string }): Promise<void> {
    this.actions.push({ kind: 'click', target: `button:${button.text}` })
    if (button.disabled) return
    if (button.submit || (!button.goto && !button.addFields && SUBMITISH.test(button.text))) {
      // 提交被站点拒绝（如必填校验）：页面出现错误提示，不跳转
      if (button.submitErrors?.length) { this.current.errors.push(...button.submitErrors); return }
      this.submitted = true
      // 提交后跳到结果页（测试提交执行器的成功判定）
      if (button.goto) await this.goto(button.goto)
      return
    }
    if (button.addFields) {
      const base = this.current.fields.length
      this.current.fields.push(...button.addFields.map((f, i) => ({ id: `f${base + i}`, label: f.label, name: f.name, type: f.type ?? 'text', options: f.options, required: !!f.required, value: f.type === 'checkbox' ? (f.value ?? 'false') : f.value, maxLength: f.maxLength, placeholder: f.placeholder, box: f.box, domHidden: f.domHidden, rejectFill: f.rejectFill } satisfies LiveField)))
    }
    if (button.goto) await this.goto(button.goto)
  }
  private bodyText(): string {
    const parts = [this.current.spec.title ?? '', this.current.spec.text ?? '', this.current.extraText]
    for (const f of this.current.fields) parts.push(f.label)
    for (const b of this.current.buttons) parts.push(b.text)
    for (const d of this.current.dialogs) if (d.visible) parts.push(d.spec.text, ...d.spec.buttons)
    if (this.current.captcha) parts.push('请完成安全验证 拖动滑块完成拼图')
    if (this.current.login) parts.push('请先登录 账号密码登录 手机验证码登录')
    return parts.filter(Boolean).join(' ')
  }
  private signals(): PageSignals {
    const buttons: ButtonInfo[] = this.current.buttons.filter(b => !b.domHidden).map(b => ({ id: b.id, text: b.text, selector: `[data-career-btn="${b.id}"]`, disabled: !!b.disabled }))
    return {
      url: this.url(), title: this.current.spec.title ?? '', text: this.bodyText(),
      hasPasswordInput: this.current.login, captchaDom: this.current.captcha, buttons,
      fileInputs: this.current.fields.filter(f => f.type === 'file').length,
      fieldCount: this.current.fields.length, errors: [...this.current.errors],
    }
  }
}

function materialize(spec: FakePageSpec): LivePage {
  const fields: LiveField[] = (spec.fields ?? []).map((f, i) => ({ id: `f${i}`, label: f.label, name: f.name, type: f.type ?? 'text', options: f.options, required: !!f.required, value: f.type === 'checkbox' ? (f.value ?? 'false') : f.value, maxLength: f.maxLength, placeholder: f.placeholder, box: f.box, domHidden: f.domHidden, rejectFill: f.rejectFill, actuatorFails: f.actuatorFails, framework: f.framework, readonly: f.readonly, neverSelects: f.neverSelects, labelUncertain: f.labelUncertain }))
  const buttons = (spec.buttons ?? []).map((b, i) => ({ ...(typeof b === 'string' ? { text: b } : b), id: `b${i}` }))
  const dialogs = (spec.dialogs ?? []).map((d, i) => ({ id: `d${i}`, spec: d, visible: !d.afterUpload }))
  return { spec, fields, buttons, captcha: !!spec.captcha, login: !!spec.login, extraText: '', errors: [...(spec.errors ?? [])], scrollY: 0, dialogs }
}
function matchOption(options: string[], want: string): string | undefined {
  const w = want.trim().toLowerCase()
  return options.find(o => o.toLowerCase() === w) ?? options.find(o => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()))
}
function unescapeAttr(s: string): string { return s.replace(/\\"/g, '"').replace(/\\\\/g, '\\') }
