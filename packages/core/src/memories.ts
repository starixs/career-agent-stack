/**
 * 长期记忆（求职助理）：模型提议、代码把关。
 *
 *  - 只记数据库别处没有的东西：沟通 / 协作习惯、用户的明确偏好与纠正、和某家公司 / 某次投递相关的零散事实。
 *    经历、求职条件、答案库、私密信息各有自己的表，调用方负责把这类内容路由过去，不在这里重复存。
 *  - scope：`user`（全局）/ `company:<公司名>` / `application:<投递 id>`；注入上下文时按当前对话涉及的对象取。
 *  - 同 scope 下内容规范化后相同 = 同一条：再写一次只加证据、抬重要度，不新增。
 *  - 删除都是软删除（forgotten / superseded），保留审计；衰减与遗忘是纯函数（decayPlan），不靠模型。
 *  - 排序是确定的：pinned DESC, importance DESC, updated_at DESC；检索按关键词（拉丁 ≥3 字、中文 ≥2 字）。
 */
import type { Db } from './db/db.js'
import { now } from './db/db.js'
import { newId } from './ids.js'

export const MEMORY_KINDS = ['fact', 'preference', 'collaboration', 'insight'] as const
export type MemoryKind = typeof MEMORY_KINDS[number]
export const MEMORY_SOURCES = ['explicit', 'extracted', 'user_edit', 'consolidation'] as const
export type MemorySource = typeof MEMORY_SOURCES[number]
export type MemoryStatus = 'active' | 'superseded' | 'forgotten'

export interface MemoryRow {
  id: string; kind: MemoryKind; scope: string; content: string; content_key: string
  importance: number; evidence_count: number; pinned: number; status: MemoryStatus
  superseded_by: string | null; source: MemorySource; source_ref: string | null
  last_used_at: string | null; last_decay_at: string | null; created_at: string; updated_at: string
}

export const MEMORY_CONTENT_MAX = 300

/** 去重键：去空白与标点、小写。 */
export function memoryKey(content: string): string {
  return content.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** scope 规范化：user / company:<名字> / application:<id>；其他一律当 user。 */
export function normalizeScope(scope: string | null | undefined): string {
  const s = (scope ?? '').trim()
  const m = /^(company|application):(.+)$/.exec(s)
  return m ? `${m[1]}:${m[2].trim()}` : 'user'
}

/** 检索词：按空白 / 标点切开；拉丁词 ≥3 字，中文词 ≥2 字；长中文词再拆成二字组。 */
export function searchTerms(q: string): string[] {
  const out = new Set<string>()
  for (const raw of q.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    if (!raw) continue
    const cjk = /[㐀-鿿]/.test(raw)
    if (!cjk) { if (raw.length >= 3) out.add(raw); continue }
    if (raw.length < 2) continue
    out.add(raw)
    if (raw.length > 3) for (let i = 0; i + 2 <= raw.length; i++) out.add(raw.slice(i, i + 2))
  }
  return [...out]
}

/** 命中分：命中的检索词个数（完整词算 2）。 */
export function matchScore(content: string, terms: string[]): number {
  if (!terms.length) return 0
  const c = content.toLowerCase()
  let score = 0
  for (const t of terms) if (c.includes(t)) score += t.length > 2 ? 2 : 1
  return score
}

const DAY = 86_400_000
/**
 * 衰减计划（纯函数）：非置顶的有效记忆，30 天没用到也没更新就降 1 级重要度（每 30 天最多一次）；
 * 自动提炼来的、重要度已到 1、半年没用的遗忘。显式让记住的和用户改过的不自动遗忘。
 */
export function decayPlan(rows: MemoryRow[], at: Date): { decay: string[]; forget: string[] } {
  const decay: string[] = []; const forget: string[] = []
  const t = at.getTime()
  for (const r of rows) {
    if (r.status !== 'active' || r.pinned) continue
    const touched = Math.max(Date.parse(r.updated_at), r.last_used_at ? Date.parse(r.last_used_at) : 0)
    const lastDecay = r.last_decay_at ? Date.parse(r.last_decay_at) : 0
    if (r.importance <= 1) {
      if (r.source === 'extracted' && t - touched > 180 * DAY) forget.push(r.id)
      continue
    }
    if (t - touched > 30 * DAY && t - lastDecay > 30 * DAY) decay.push(r.id)
  }
  return { decay, forget }
}

const clampImportance = (n: number | undefined, fallback = 3) => Math.min(5, Math.max(1, Math.round(n ?? fallback)))

export interface RememberInput { kind: MemoryKind; scope?: string | null; content: string; importance?: number; source: MemorySource; source_ref?: string | null; pinned?: boolean }
export interface ListMemoryOptions { scope?: string; scopes?: string[]; status?: MemoryStatus | 'all'; q?: string; limit?: number; offset?: number }

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  get(id: string): MemoryRow | undefined { return this.db.get<MemoryRow>('SELECT * FROM memory WHERE id=?', [id]) }

  /** 记住一条：同 scope 同内容就加强（证据 +1、重要度取高）；返回是新建还是加强。 */
  remember(input: RememberInput): { memory: MemoryRow; action: 'created' | 'reinforced' } {
    const content = input.content.trim().replace(/\s+/g, ' ').slice(0, MEMORY_CONTENT_MAX)
    if (!content) throw new Error('记忆内容不能为空')
    if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) throw new Error(`未知的记忆类型：${input.kind}`)
    const scope = normalizeScope(input.scope)
    const key = memoryKey(content)
    const t = now()
    const existing = this.db.get<MemoryRow>("SELECT * FROM memory WHERE scope=? AND content_key=? AND status='active'", [scope, key])
    if (existing) {
      this.db.run('UPDATE memory SET evidence_count=evidence_count+1, importance=MAX(importance, ?), pinned=MAX(pinned, ?), updated_at=? WHERE id=?',
        [clampImportance(input.importance), input.pinned ? 1 : 0, t, existing.id])
      return { memory: this.get(existing.id)!, action: 'reinforced' }
    }
    const id = newId('mem')
    this.db.run(`INSERT INTO memory(id, kind, scope, content, content_key, importance, evidence_count, pinned, status, source, source_ref, created_at, updated_at)
      VALUES (?,?,?,?,?,?,1,?, 'active', ?,?,?,?)`,
      [id, input.kind, scope, content, key, clampImportance(input.importance), input.pinned ? 1 : 0, input.source, input.source_ref ?? null, t, t])
    return { memory: this.get(id)!, action: 'created' }
  }

  /** 列表 / 检索：确定排序；有 q 时只留命中的、按命中分优先。 */
  list(opts: ListMemoryOptions = {}): MemoryRow[] {
    const where: string[] = []; const params: string[] = []
    const status = opts.status ?? 'active'
    if (status !== 'all') { where.push('status=?'); params.push(status) }
    const scopes = opts.scopes ?? (opts.scope ? [opts.scope] : undefined)
    if (scopes?.length) { where.push(`scope IN (${scopes.map(() => '?').join(',')})`); params.push(...scopes.map(normalizeScope)) }
    const rows = this.db.all<MemoryRow>(`SELECT * FROM memory ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, importance DESC, updated_at DESC`, params)
    const limit = opts.limit ?? 50; const offset = opts.offset ?? 0
    if (!opts.q?.trim()) return rows.slice(offset, offset + limit)
    const terms = searchTerms(opts.q)
    return rows.map(r => ({ r, s: matchScore(r.content, terms) })).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || b.r.pinned - a.r.pinned || b.r.importance - a.r.importance || b.r.updated_at.localeCompare(a.r.updated_at))
      .slice(offset, offset + limit).map(x => x.r)
  }

  /**
   * 注入上下文用：全局 + 当前涉及的公司 / 投递，取最强的 limit 条；有当前话题时命中的优先。记下 last_used_at（衰减按它算）。
   */
  forContext(opts: { scopes?: string[]; q?: string; limit?: number } = {}): MemoryRow[] {
    const scopes = ['user', ...(opts.scopes ?? []).map(normalizeScope).filter(s => s !== 'user')]
    const limit = opts.limit ?? 8
    const all = this.list({ scopes, limit: 500 })
    const terms = opts.q ? searchTerms(opts.q) : []
    const picked = terms.length
      ? all.map(r => ({ r, s: matchScore(r.content, terms) })).sort((a, b) => b.s - a.s || b.r.pinned - a.r.pinned || b.r.importance - a.r.importance || b.r.updated_at.localeCompare(a.r.updated_at)).slice(0, limit).map(x => x.r)
      : all.slice(0, limit)
    if (picked.length) {
      const t = now()
      this.db.run(`UPDATE memory SET last_used_at=? WHERE id IN (${picked.map(() => '?').join(',')})`, [t, ...picked.map(r => r.id)])
    }
    return picked
  }

  /** 用户在页面上改：内容 / 重要度 / 置顶 / 类型。改内容会更新去重键。 */
  update(id: string, patch: { content?: string; importance?: number; pinned?: boolean; kind?: MemoryKind }): MemoryRow {
    const cur = this.get(id)
    if (!cur) throw new Error(`记忆不存在：${id}`)
    const content = patch.content !== undefined ? patch.content.trim().replace(/\s+/g, ' ').slice(0, MEMORY_CONTENT_MAX) : cur.content
    if (!content) throw new Error('记忆内容不能为空')
    if (patch.kind && !(MEMORY_KINDS as readonly string[]).includes(patch.kind)) throw new Error(`未知的记忆类型：${patch.kind}`)
    this.db.run('UPDATE memory SET content=?, content_key=?, importance=?, pinned=?, kind=?, source=?, updated_at=? WHERE id=?', [
      content, memoryKey(content), patch.importance !== undefined ? clampImportance(patch.importance) : cur.importance,
      patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned, patch.kind ?? cur.kind,
      patch.content !== undefined ? 'user_edit' : cur.source, now(), id,
    ])
    return this.get(id)!
  }

  /** 忘掉（软删除）。 */
  forget(id: string): boolean { return this.db.run("UPDATE memory SET status='forgotten', updated_at=? WHERE id=? AND status='active'", [now(), id]).changes > 0 }

  /** 新说法取代旧的（用户纠正 / 巩固合并）：旧的标 superseded 并指向新的。 */
  supersede(oldIds: string[], input: RememberInput): MemoryRow {
    const created = this.remember(input).memory
    const t = now()
    for (const id of oldIds) if (id !== created.id) this.db.run("UPDATE memory SET status='superseded', superseded_by=?, updated_at=? WHERE id=? AND status='active'", [created.id, t, id])
    return created
  }

  /** 按衰减计划执行；返回降级 / 遗忘的条数。 */
  applyDecay(at = new Date()): { decayed: number; forgotten: number } {
    const plan = decayPlan(this.db.all<MemoryRow>("SELECT * FROM memory WHERE status='active'"), at)
    const t = at.toISOString()
    for (const id of plan.decay) this.db.run('UPDATE memory SET importance=importance-1, last_decay_at=? WHERE id=?', [t, id])
    for (const id of plan.forget) this.db.run("UPDATE memory SET status='forgotten', updated_at=? WHERE id=?", [t, id])
    return { decayed: plan.decay.length, forgotten: plan.forget.length }
  }
}
