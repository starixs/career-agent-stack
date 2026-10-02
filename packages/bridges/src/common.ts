/**
 * 桥接层公共工具：fetch 封装、子进程托管、路径解析。
 * 所有外部依赖（fetch / spawn）都可注入，便于在测试里替换。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** HTTP 非 2xx 时抛出，带状态码与响应体，方便上层判断 409/400 等业务冲突。 */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`)
    this.name = 'HttpError'
  }
  /** 尝试把响应体当 JSON 解析（失败返回 undefined）。 */
  json<T = Record<string, unknown>>(): T | undefined {
    try { return JSON.parse(this.body) as T } catch { return undefined }
  }
}

export interface JsonRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
  query?: Record<string, string | number | boolean | undefined | null>
}

export function withQuery(url: string, query?: JsonRequestInit['query']): string {
  if (!query) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  return u.toString()
}

/** 发请求并解析 JSON；非 2xx 抛 HttpError。返回值附带响应头，调用方可取 X-Total-Count 之类。 */
export async function fetchJson<T = unknown>(fetchImpl: FetchLike, url: string, init: JsonRequestInit = {}): Promise<{ data: T; headers: Headers; status: number }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000)
  try {
    const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) }
    let body: string | undefined
    if (init.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(init.body) }
    const res = await fetchImpl(withQuery(url, init.query), { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) throw new HttpError(res.status, url, text)
    const data = (text.trim() ? JSON.parse(text) : null) as T
    return { data, headers: res.headers, status: res.status }
  } finally { clearTimeout(timer) }
}

export async function fetchText(fetchImpl: FetchLike, url: string, init: JsonRequestInit = {}): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000)
  try {
    const res = await fetchImpl(withQuery(url, init.query), { method: init.method ?? 'GET', headers: init.headers, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) throw new HttpError(res.status, url, text)
    return text
  } finally { clearTimeout(timer) }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 仓库根目录（career-agent-stack/），modules/ 与 app/ 的父目录。 */
export function stackRoot(): string {
  // src/common.ts 与 dist/common.js 深度相同：app/packages/bridges/{src|dist}
  return resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
}
export function moduleDir(name: string): string { return resolve(stackRoot(), 'modules', name) }

export interface ManagedProcessOptions {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  /** 就绪探测：返回 true 表示服务可用。 */
  isReady: () => Promise<boolean>
  startTimeoutMs?: number
  pollIntervalMs?: number
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void
}

/** 以子进程方式托管一个本地 HTTP 服务：启动 → 轮询就绪 → stop。 */
export class ManagedProcess {
  child: ChildProcess | null = null
  private logTail: string[] = []
  constructor(public readonly opts: ManagedProcessOptions) {}

  get running(): boolean { return !!this.child && this.child.exitCode === null && !this.child.killed }

  async start(): Promise<void> {
    if (await this.opts.isReady().catch(() => false)) return // 已有实例在跑，直接复用
    const spawnImpl = this.opts.spawnImpl ?? spawn
    const child = spawnImpl(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        this.logTail.push(`[${stream}] ${line}`); if (this.logTail.length > 50) this.logTail.shift()
        this.opts.onLog?.(line, stream)
      }
    }
    child.stdout?.on('data', capture('stdout'))
    child.stderr?.on('data', capture('stderr'))
    const exitState: { exited: { code: number | null; signal: NodeJS.Signals | null } | null } = { exited: null }
    child.on('exit', (code, signal) => { exitState.exited = { code, signal } })
    child.on('error', (err) => { this.logTail.push(`[error] ${err.message}`) })

    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 60_000)
    const interval = this.opts.pollIntervalMs ?? 500
    while (Date.now() < deadline) {
      if (exitState.exited) throw new Error(`子进程提前退出（code=${exitState.exited.code}, signal=${exitState.exited.signal}）：\n${this.logTail.join('\n')}`)
      if (await this.opts.isReady().catch(() => false)) return
      await sleep(interval)
    }
    await this.stop()
    throw new Error(`服务启动超时（${this.opts.command} ${this.opts.args.join(' ')}）：\n${this.logTail.join('\n')}`)
  }

  async stop(graceMs = 5_000): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) { this.child = null; return }
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, graceMs)
      child.once('exit', () => { clearTimeout(timer); done() })
      try { child.kill('SIGTERM') } catch { clearTimeout(timer); done() }
    })
    this.child = null
  }

  /** 最近 50 行日志，排障用。 */
  logs(): string[] { return [...this.logTail] }
}

/** 通用的 HTTP 就绪探测：GET url 返回 2xx 即就绪。 */
export function httpReady(fetchImpl: FetchLike, url: string, timeoutMs = 2_000): () => Promise<boolean> {
  return async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try { const res = await fetchImpl(url, { signal: ctrl.signal }); return res.ok } catch { return false } finally { clearTimeout(timer) }
  }
}

export function envStr(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name]
  return v && v.trim() ? v.trim() : fallback
}
