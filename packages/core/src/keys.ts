import { createHash } from 'node:crypto'

/** 内容哈希与稳定键：审批绑定、材料包、岗位身份共用。 */
export function sha256(s: string | Uint8Array): string { return createHash('sha256').update(s).digest('hex') }

/** 规范化 JSON：键按码点排序、无空白；同一内容永远得到同一字符串（用于内容哈希）。 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v))
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined).map(k => [k, sortKeys((v as Record<string, unknown>)[k])]))
  return v
}

/**
 * 稳定岗位键：本地库与服务端岗位库共用的岗位身份。
 *  - 有原站岗位号：`<platform>:<source_job_id>`
 *  - 只有网址：`url:<规范化网址的 sha256 前 16 位>`（去掉 hash、utm_* 等追踪参数、末尾斜杠）
 *  - 都没有：`hash:<公司|职位|地点 的 sha256 前 16 位>`
 */
export function jobKey(j: { source_platform?: string | null; source_job_id?: string | null; url?: string | null; company_name?: string | null; title?: string | null; location?: string | null }): string {
  if (j.source_job_id) return `${(j.source_platform ?? 'unknown').toLowerCase()}:${j.source_job_id}`
  const url = normalizeJobUrl(j.url)
  if (url) return `url:${sha256(url).slice(0, 16)}`
  return `hash:${sha256([j.company_name ?? '', j.title ?? '', j.location ?? ''].map(s => s.trim().toLowerCase()).join('|')).slice(0, 16)}`
}
export function normalizeJobUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.trim())
    u.hash = ''
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|spm|from|source|ref|share|trace|_t$|ts$)/i.test(k)) u.searchParams.delete(k)
    u.searchParams.sort()
    return `${u.protocol}//${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch { return raw.trim() || null }
}

