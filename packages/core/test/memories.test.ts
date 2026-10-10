import { describe, it, expect } from 'vitest'
import { Db, Repos, decayPlan, memoryKey, normalizeScope, searchTerms, type MemoryRow } from '../src/index.js'

function mem() { const db = new Db(':memory:'); db.migrate(); return new Repos(db) }

describe('长期记忆', () => {
  it('同 scope 同内容（标点空白不同）只存一条：再记一次加证据、抬重要度', () => {
    const r = mem()
    const a = r.memories.remember({ kind: 'collaboration', content: '回复先说结论，再说依据。', importance: 2, source: 'extracted' })
    expect(a.action).toBe('created')
    const b = r.memories.remember({ kind: 'collaboration', content: '回复先说结论 再说依据', importance: 4, source: 'explicit' })
    expect(b.action).toBe('reinforced')
    expect(b.memory.id).toBe(a.memory.id)
    expect(b.memory.evidence_count).toBe(2)
    expect(b.memory.importance).toBe(4)
    // 不同 scope 是两条
    const c = r.memories.remember({ kind: 'fact', scope: 'company:美团', content: '回复先说结论，再说依据', source: 'extracted' })
    expect(c.action).toBe('created')
    expect(memoryKey('A b，C')).toBe('abc')
  })

  it('scope 规范化；未知类型 / 空内容报错', () => {
    expect(normalizeScope('company: 美团 ')).toBe('company:美团')
    expect(normalizeScope('application:app_1')).toBe('application:app_1')
    expect(normalizeScope('book:1')).toBe('user')
    expect(normalizeScope(undefined)).toBe('user')
    const r = mem()
    expect(() => r.memories.remember({ kind: 'nope' as never, content: 'x', source: 'explicit' })).toThrow()
    expect(() => r.memories.remember({ kind: 'fact', content: '   ', source: 'explicit' })).toThrow()
  })

  it('排序确定：置顶 > 重要度 > 更新时间；检索按关键词，中文拆二字组', () => {
    const r = mem()
    r.memories.remember({ kind: 'preference', content: '不考虑外包岗位', importance: 3, source: 'explicit' })
    const pinned = r.memories.remember({ kind: 'collaboration', content: '称呼用"你"，不要用"您"', importance: 1, source: 'explicit', pinned: true }).memory
    r.memories.remember({ kind: 'preference', content: '优先上海和杭州的岗位', importance: 5, source: 'explicit' })
    const list = r.memories.list()
    expect(list[0].id).toBe(pinned.id)
    expect(list[1].content).toContain('上海')
    expect(searchTerms('外包岗位 python')).toEqual(expect.arrayContaining(['外包岗位', '外包', '岗位', 'python']))
    expect(r.memories.list({ q: '外包' }).map(m => m.content)).toEqual(['不考虑外包岗位'])
    expect(r.memories.list({ q: '完全不相关' })).toEqual([])
  })

  it('注入上下文：全局 + 当前公司，不串到别家；记下 last_used_at', () => {
    const r = mem()
    r.memories.remember({ kind: 'collaboration', content: '回复先说结论', source: 'explicit' })
    r.memories.remember({ kind: 'fact', scope: 'company:美团', content: '美团网申要微信扫码登录', source: 'extracted' })
    r.memories.remember({ kind: 'fact', scope: 'company:字节', content: '字节一面问了 Transformer', source: 'extracted' })
    const picked = r.memories.forContext({ scopes: ['company:美团'] })
    expect(picked.map(m => m.content).sort()).toEqual(['回复先说结论', '美团网申要微信扫码登录'])
    expect(picked.every(m => r.memories.get(m.id)!.last_used_at)).toBe(true)
    expect(r.memories.forContext({ limit: 1, q: '登录 扫码', scopes: ['company:美团'] })[0].content).toContain('扫码')
  })

  it('用户编辑 / 忘掉 / 取代：软删除保留记录，取代链可追', () => {
    const r = mem()
    const old = r.memories.remember({ kind: 'preference', content: '期望薪资 20k', source: 'extracted' }).memory
    const edited = r.memories.update(old.id, { content: '期望薪资 25k', pinned: true })
    expect(edited).toMatchObject({ content: '期望薪资 25k', pinned: 1, source: 'user_edit' })
    const next = r.memories.supersede([old.id], { kind: 'preference', content: '期望薪资 30k 起', source: 'explicit' })
    expect(r.memories.get(old.id)).toMatchObject({ status: 'superseded', superseded_by: next.id })
    expect(r.memories.forget(next.id)).toBe(true)
    expect(r.memories.forget(next.id)).toBe(false)
    expect(r.memories.list()).toEqual([])
    expect(r.memories.list({ status: 'all' })).toHaveLength(2)
  })

  it('衰减（纯函数）：30 天没用降一级、置顶不动；提炼来的低重要度半年没用才遗忘', () => {
    const base = { kind: 'fact', scope: 'user', content: 'x', content_key: 'x', evidence_count: 1, status: 'active', superseded_by: null, source_ref: null, last_decay_at: null, created_at: '2026-01-01T00:00:00Z' } as const
    const rows: MemoryRow[] = [
      { ...base, id: 'old', importance: 3, pinned: 0, source: 'extracted', last_used_at: null, updated_at: '2026-01-01T00:00:00Z' },
      { ...base, id: 'pinned', importance: 3, pinned: 1, source: 'extracted', last_used_at: null, updated_at: '2026-01-01T00:00:00Z' },
      { ...base, id: 'fresh', importance: 3, pinned: 0, source: 'extracted', last_used_at: '2026-09-30T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      { ...base, id: 'stale-low', importance: 1, pinned: 0, source: 'extracted', last_used_at: null, updated_at: '2026-01-01T00:00:00Z' },
      { ...base, id: 'explicit-low', importance: 1, pinned: 0, source: 'explicit', last_used_at: null, updated_at: '2026-01-01T00:00:00Z' },
    ]
    expect(decayPlan(rows, new Date('2026-10-10T00:00:00Z'))).toEqual({ decay: ['old'], forget: ['stale-low'] })
    const r = mem()
    r.memories.remember({ kind: 'fact', content: '很久以前的事', source: 'extracted' })
    expect(r.memories.applyDecay(new Date(Date.now() + 40 * 86_400_000))).toEqual({ decayed: 1, forgotten: 0 })
    expect(r.memories.list()[0].importance).toBe(2)
  })
})
