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
  forget(host: string): void { this.store.kvSet(siteMapKey(host), {}); this.store.kvSet(widgetMapKey(host), {}) }
  /** 同一个存储上的站点控件记忆（shell 只传 siteMemory 也能用）。 */
  widgets(): WidgetMemory { return new WidgetMemory(this.store) }
  /** 给 interpretForm 的 recallKey 用。 */
  recaller(host: string): (field: FieldSignatureInput) => string | undefined {
    return field => this.recall(host, field)?.key
  }
}

/**
 * 站点控件记忆（自学习）：某站某种控件（按控件指纹，见 widgetSignatureScript）上次哪种做法成功 / 失败，
 * 下次同站同类控件优先用成功的做法、跳过已知会失败的试探。存在 kv：apply:widget_map:<host>。
 * 只记"怎么操作"，不记任何字段值。
 */
export interface WidgetKnowledge {
  kind: 'select' | 'date'
  /** 输入框打字后候选会不会变（false = 不可搜索，以后同类控件不再打字）。 */
  searchable?: boolean
  /** 弹层是怎么认出来的（aria / class / mutation / options）。 */
  popup?: string
  /** 读回位置：label 节点 / 输入框值 / 可见文字。 */
  readback?: string
  /** 日期：直接输入成功还是面板导航成功。 */
  dateStrategy?: 'typed' | 'panel'
  /** 日期：直接输入时被接受的写法（YYYY-MM / YYYY/MM / …）。 */
  dateFormat?: string
  ok: number
  fail: number
  lastCode?: string
  updatedAt: string
}
export type WidgetPatch = Partial<Omit<WidgetKnowledge, 'ok' | 'fail' | 'updatedAt'>>
export const widgetMapKey = (host: string) => `apply:widget_map:${normalizeHost(host)}`
/** 绑定到某个 host 的控件记忆（fill.ts 只依赖这个小接口）。 */
export interface BoundWidgetMemory {
  recall(sig: string): WidgetKnowledge | undefined
  learn(sig: string, patch: WidgetPatch, ok: boolean, code?: string): void
}
export class WidgetMemory {
  constructor(private readonly store: SiteMemoryStore) {}
  mapFor(host: string): Record<string, WidgetKnowledge> { return this.store.kvGet<Record<string, WidgetKnowledge>>(widgetMapKey(host)) ?? {} }
  recall(host: string, sig: string): WidgetKnowledge | undefined { return sig ? this.mapFor(host)[sig] : undefined }
  learn(host: string, sig: string, patch: WidgetPatch, ok: boolean, code?: string): WidgetKnowledge | undefined {
    if (!sig || !patch.kind) return undefined
    const map = this.mapFor(host)
    const prev = map[sig]
    // 成功的做法覆盖旧记忆；失败只累计次数和原因，不抹掉以前成功过的做法
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as WidgetPatch
    const next: WidgetKnowledge = ok
      ? { ...prev, ...defined, kind: patch.kind, ok: (prev?.ok ?? 0) + 1, fail: prev?.fail ?? 0, lastCode: prev?.lastCode, updatedAt: new Date().toISOString() }
      : { ...defined, ...prev, kind: patch.kind, ok: prev?.ok ?? 0, fail: (prev?.fail ?? 0) + 1, lastCode: code, updatedAt: new Date().toISOString() }
    // "不可搜索"是失败里学到的确定结论，也要记下
    if (!ok && patch.searchable === false) next.searchable = false
    map[sig] = next
    this.store.kvSet(widgetMapKey(host), map)
    return next
  }
  bind(host: string, onEvent?: (e: { kind: 'used' | 'learned'; sig: string; detail: string }) => void): BoundWidgetMemory {
    return {
      recall: sig => { const k = this.recall(host, sig); if (k && onEvent) onEvent({ kind: 'used', sig, detail: describeKnowledge(k) }); return k },
      learn: (sig, patch, ok, code) => {
        const before = this.recall(host, sig)
        const k = this.learn(host, sig, patch, ok, code)
        if (k && onEvent && describeKnowledge(k) !== (before ? describeKnowledge(before) : '')) onEvent({ kind: 'learned', sig, detail: describeKnowledge(k) })
      },
    }
  }
}
export function describeKnowledge(k: WidgetKnowledge): string {
  return [k.kind, k.searchable === undefined ? '' : k.searchable ? '可搜索' : '不可搜索', k.popup ? `弹层:${k.popup}` : '', k.dateStrategy ? `日期:${k.dateStrategy}` : '', k.dateFormat ? `格式:${k.dateFormat}` : ''].filter(Boolean).join(' ')
}
