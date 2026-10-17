import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 运行记录（遥测）：每次 drive 一个目录 `<root>/<runId>/`：
 *  - trace.jsonl：每步一行 {t, ms, stage, field, label, strategy, action, result, code, detail, shot}；
 *  - shot-<n>-<name>.jpg：动作前后的小截图（数量 / 单张 / 总量都有上限；敏感输入框截图前模糊）；
 *  - dom-<n>-<name>.html：失败时相关 DOM 片段（截断）；
 *  - summary.json：站点、组件库指纹、字段统计、原因码分布、弹窗处理、用到的层。
 * 写盘失败一律吞掉：遥测是给迭代用的，不能影响填表。只保留最近 keep 次（按修改时间）。
 * 值一律经 maskValue：手机 / 邮箱 / 证件号只留前后几位。
 */
export interface TraceEvent {
  stage: string
  action?: string
  field?: string
  label?: string
  strategy?: string
  result?: 'ok' | 'fail' | 'skip' | 'info'
  code?: string
  detail?: string
  value?: string
  ms?: number
  shot?: string
}
export interface RunSummary {
  runId: string
  host: string
  startedAt: string
  finishedAt?: string
  status?: string
  libraries: string[]
  fields: { total: number; verified: number; needsUser: number; mismatch: number; emptyOptional: number; labelUncertain: number }
  codes: Record<string, number>
  blockers: Array<{ text: string; choice?: string; by: string; resolved: boolean }>
  entryClicked?: string
  layersUsed?: string[]
  requiredTrusted?: boolean
  pages: number
  shots: number
}
export interface TelemetryOptions {
  /** 根目录（shell 传 `$CAREER_DATA_DIR/runs`）。 */
  dir: string
  /** actionId 或 runId；只保留文件名安全字符。 */
  runId: string
  keep?: number
  maxShots?: number
  maxShotBytes?: number
  maxTotalShotBytes?: number
}

const SENSITIVE_LABEL_RX = /(手机|电话|联系方式|mobile|phone|tel|邮箱|e-?mail|身份证|证件|护照|id ?(number|card)|银行卡|账号|密码|password|微信|qq)/i
const EMAIL_RX = /([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+)/g
const LONG_DIGITS_RX = /(\d{3})\d{4,}(\d{2,4})/g
const ID_RX = /(\d{3})\d{11}([\dXx]{4})/g

/** 文本里的手机 / 邮箱 / 证件号打码（只留前后几位）。 */
export function maskText(s: string): string {
  return s.replace(EMAIL_RX, '$1***$2').replace(ID_RX, '$1***********$2').replace(LONG_DIGITS_RX, (_m, a: string, b: string) => `${a}****${b}`)
}
/** 按标签判断敏感字段：整值只留前 3 后 2；否则做文本级打码。 */
export function maskValue(label: string | undefined, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (label && SENSITIVE_LABEL_RX.test(label)) return value.length <= 5 ? '***' : `${value.slice(0, 3)}***${value.slice(-2)}`
  return maskText(value)
}
export function isSensitiveLabel(label: string | undefined): boolean { return !!label && SENSITIVE_LABEL_RX.test(label) }

export interface Recorder {
  readonly dir?: string
  readonly runId?: string
  trace(ev: TraceEvent): void
  /** 截图并落盘（已限额）；返回文件名。capture 由调用方提供（引擎里会先模糊敏感框）。 */
  shot(name: string, capture: () => Promise<Uint8Array | undefined>): Promise<string | undefined>
  dom(name: string, html: string): string | undefined
  summary(patch: Partial<RunSummary>): void
  bump(code: string): void
  finish(patch?: Partial<RunSummary>): void
}

export const noopRecorder: Recorder = { trace() {}, async shot() { return undefined }, dom() { return undefined }, summary() {}, bump() {}, finish() {} }

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || `run_${Date.now()}`

export class RunRecorder implements Recorder {
  readonly dir: string
  readonly runId: string
  private readonly t0 = Date.now()
  private shots = 0
  private shotBytes = 0
  private seq = 0
  private sum: RunSummary
  private ok = true
  constructor(private readonly opts: TelemetryOptions, host = '') {
    this.runId = safeId(opts.runId)
    this.dir = join(opts.dir, this.runId)
    this.sum = { runId: this.runId, host, startedAt: new Date().toISOString(), libraries: [], fields: { total: 0, verified: 0, needsUser: 0, mismatch: 0, emptyOptional: 0, labelUncertain: 0 }, codes: {}, blockers: [], pages: 0, shots: 0 }
    try { mkdirSync(this.dir, { recursive: true }); prune(opts.dir, opts.keep ?? 50, this.runId) } catch { this.ok = false }
  }
  private write(file: string, data: string | Uint8Array, append = false): boolean {
    if (!this.ok) return false
    try { if (append) appendFileSync(join(this.dir, file), data); else writeFileSync(join(this.dir, file), data); return true } catch { return false }
  }
  trace(ev: TraceEvent): void {
    const line = { t: new Date().toISOString(), at: Date.now() - this.t0, ...ev, ...(ev.value !== undefined ? { value: maskValue(ev.label, ev.value) } : {}), ...(ev.detail ? { detail: maskText(ev.detail).slice(0, 1500) } : {}) }
    this.write('trace.jsonl', JSON.stringify(line) + '\n', true)
  }
  async shot(name: string, capture: () => Promise<Uint8Array | undefined>): Promise<string | undefined> {
    const max = this.opts.maxShots ?? 40
    if (!this.ok || this.shots >= max || this.shotBytes >= (this.opts.maxTotalShotBytes ?? 12 * 1024 * 1024)) return undefined
    let bytes: Uint8Array | undefined
    try { bytes = await capture() } catch { return undefined }
    if (!bytes || bytes.byteLength > (this.opts.maxShotBytes ?? 600 * 1024)) return undefined
    const file = `shot-${String(++this.seq).padStart(3, '0')}-${safeId(name)}.jpg`
    if (!this.write(file, bytes)) return undefined
    this.shots++; this.shotBytes += bytes.byteLength; this.sum.shots = this.shots
    return file
  }
  dom(name: string, html: string): string | undefined {
    const file = `dom-${String(++this.seq).padStart(3, '0')}-${safeId(name)}.html`
    return this.write(file, maskText(html).slice(0, 20_000)) ? file : undefined
  }
  summary(patch: Partial<RunSummary>): void { this.sum = { ...this.sum, ...patch } }
  bump(code: string): void { this.sum.codes[code] = (this.sum.codes[code] ?? 0) + 1 }
  finish(patch: Partial<RunSummary> = {}): void {
    this.sum = { ...this.sum, ...patch, finishedAt: new Date().toISOString() }
    this.write('summary.json', JSON.stringify(this.sum, null, 2))
  }
}

/** 只保留最近 keep 个运行目录（不删当前这次）。 */
function prune(root: string, keep: number, current: string): void {
  let entries: Array<{ name: string; mtime: number }>
  try {
    entries = readdirSync(root).filter(n => n !== current).flatMap(name => { const st = statSync(join(root, name)); return st.isDirectory() ? [{ name, mtime: st.mtimeMs }] : [] })
  } catch { return }
  entries.sort((a, b) => b.mtime - a.mtime)
  for (const e of entries.slice(Math.max(0, keep - 1))) { try { rmSync(join(root, e.name), { recursive: true, force: true }) } catch { /* ignore */ } }
}
