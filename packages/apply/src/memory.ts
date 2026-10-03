import { normKey } from './text.js'

/**
 * 站点映射记忆（借鉴 quillfill 的"域名 → 映射表，二次访问零推理直填"）：
 * 某站某个字段（按 name / xpath / 标签三种签名）上次填的是资料里的哪个键，读回核对通过就记下来；
 * 下次同一站别名匹配不到时直接复用。存在 kv：apply:site_map:<host>。
 */
export type MappingSource = 'alias' | 'learned' | 'user'
export interface SiteMapping { key: string; source: MappingSource; hits: number; lastSeen: string; label?: string }
export interface SiteMemoryStore { kvGet<T = unknown>(key: string): T | undefined; kvSet(key: string, value: unknown): void }
export interface FieldSignatureInput { name?: string; xpath?: string; label?: string }

export const siteMapKey = (host: string) => `apply:site_map:${normalizeHost(host)}`
export function normalizeHost(urlOrHost: string): string {
  let h = urlOrHost.trim().toLowerCase()
  try { if (/^[a-z]+:\/\//.test(h)) h = new URL(h).hostname } catch { /* 当 host 用 */ }
  return h.replace(/^www\./, '').replace(/[/:].*$/, '')
}

/** 签名按稳定性排序：name > xpath > 标签。 */
export function fieldSignatures(f: FieldSignatureInput): string[] {
  const out: string[] = []
  if (f.name && !/^\d+$/.test(f.name) && !/^(f\d+|input\d*)$/i.test(f.name)) out.push(`name:${f.name}`)
  if (f.xpath) out.push(`xpath:${f.xpath}`)
  if (f.label && normKey(f.label)) out.push(`label:${normKey(f.label)}`)
  return out
}

export class SiteMemory {
  constructor(private readonly store: SiteMemoryStore) {}
  mapFor(host: string): Record<string, SiteMapping> { return this.store.kvGet<Record<string, SiteMapping>>(siteMapKey(host)) ?? {} }
  recall(host: string, field: FieldSignatureInput): SiteMapping | undefined {
    const map = this.mapFor(host)
    for (const sig of fieldSignatures(field)) { const m = map[sig]; if (m) return m }
    return undefined
  }
  remember(host: string, field: FieldSignatureInput, key: string, source: MappingSource = 'alias'): void {
    const sigs = fieldSignatures(field)
    if (!sigs.length || !key) return
    const map = this.mapFor(host)
    const now = new Date().toISOString()
    for (const sig of sigs) {
      const prev = map[sig]
      // 用户纠正优先级最高，不被别名记忆覆盖
      if (prev && prev.source === 'user' && source !== 'user') continue
      map[sig] = { key, source, hits: (prev?.key === key ? prev.hits : 0) + 1, lastSeen: now, label: field.label }
    }
    this.store.kvSet(siteMapKey(host), map)
  }
  forget(host: string): void { this.store.kvSet(siteMapKey(host), {}) }
  /** 给 interpretForm 的 recallKey 用。 */
  recaller(host: string): (field: FieldSignatureInput) => string | undefined {
    return field => this.recall(host, field)?.key
  }
}
