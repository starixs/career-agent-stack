import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Db, Repos } from '@career/core'

/** 内存库：直接执行 core 的 schema.sql（core 的 dist 里不带 .sql，所以不用 migrate()）。 */
export function memRepos(): Repos {
  const db = new Db(':memory:')
  const sql = readFileSync(fileURLToPath(new URL('../../core/src/db/schema.sql', import.meta.url)), 'utf8')
  db.raw.exec(sql)
  return new Repos(db)
}

export interface RecordedRequest { url: string; method: string; headers: Record<string, string>; body: unknown }

/** 可编程的 fetch mock：按 URL 片段匹配返回；记录所有请求。 */
export function fakeFetch(routes: Array<{ match: string | RegExp; status?: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: RecordedRequest[] = []
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v
    let body: unknown = null
    if (typeof init?.body === 'string') { try { body = JSON.parse(init.body) } catch { body = init.body } }
    calls.push({ url: input, method: init?.method ?? 'GET', headers, body })
    const route = routes.find(r => (typeof r.match === 'string' ? input.includes(r.match) : r.match.test(input)))
    if (!route) return new Response(JSON.stringify({ error: 'no route' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    const text = typeof route.body === 'string' ? route.body : JSON.stringify(route.body)
    return new Response(text, { status: route.status ?? 200, headers: { 'Content-Type': 'application/json', ...(route.headers ?? {}) } })
  }
  return { fetchImpl, calls }
}
