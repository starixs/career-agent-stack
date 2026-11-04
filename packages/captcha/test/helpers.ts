import type { CdpSessionLike, CaptchaPage } from '../src/types.js'

/** 记录型假 CDP：按需回放方法结果，捕获全部命令（human-input 断言用）。 */
export class FakeCdp implements CdpSessionLike {
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = []
  private readonly replies = new Map<string, (p: Record<string, unknown>) => unknown>()

  reply(method: string, fn: (p: Record<string, unknown>) => unknown): this {
    this.replies.set(method, fn)
    return this
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ method, params })
    const fn = this.replies.get(method)
    return fn ? fn(params) : {}
  }

  mouseEvents() { return this.commands.filter(c => c.method === 'Input.dispatchMouseEvent') }
  mouseTypes() { return this.mouseEvents().map(c => c.params.type as string) }
  keyEvents() { return this.commands.filter(c => c.method === 'Input.dispatchKeyEvent') }
  reset() { this.commands.length = 0 }
}

export interface FakePageOptions {
  url?: string
  /** evalJson 按表达式内容回放（用 includes 匹配片段）。 */
  evals?: Array<{ match: string; result: unknown }>
  viewport?: { width: number; height: number }
  hasCdp?: boolean
}

/** 假页：evalJson 回放 + 可选假 CDP。 */
export class FakeCaptchaPage implements CaptchaPage {
  readonly cdpInstance: FakeCdp
  private readonly evals: Array<{ match: string; result: unknown }>

  constructor(opts: FakePageOptions = {}) {
    this.cdpInstance = new FakeCdp()
      .reply('Page.captureScreenshot', () => ({ data: Buffer.from('png').toString('base64') }))
    this.evals = opts.evals ?? []
    this.hasCdp = opts.hasCdp ?? true
    this.urlValue = opts.url ?? 'https://zhipin.com/apply'
    this.viewportValue = opts.viewport ?? { width: 1366, height: 768 }
  }

  private hasCdp: boolean
  private urlValue: string
  private viewportValue: { width: number; height: number }

  url(): string { return this.urlValue }
  cdp(): CdpSessionLike | null { return this.hasCdp ? this.cdpInstance : null }
  async evalJson<T>(expr: string): Promise<T> {
    for (const e of this.evals) if (expr.includes(e.match)) return e.result as T
    return null as T
  }
  async screenshot(): Promise<Uint8Array> { return new Uint8Array([1, 2, 3]) }
  async viewport() { return this.viewportValue }
  async waitForTimeout() {}
}
