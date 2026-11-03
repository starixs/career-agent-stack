import { extractJson, type LLM } from '@career/core'
import type { FormField } from './extract.js'
import type { Profile } from './interpret.js'
import { entriesFor, matchRowField, SECTIONS, type SectionKey } from './sections.js'

/**
 * 起止范围格子（「起止时间」一个标签管开始 / 结束两格）分区按行没填上时的兜底：不交给人，要正确填完（2026-10-31 你定）。
 *  1. 按 DOM 顺序找它前面最近的锚字段（学校 / 公司 / 项目名），认出是哪一段经历、第几段；同一段里先出现的是开始、后出现的是结束；
 *  2. 前面没有锚字段：把整页字段顺序和资料里的各段时间交给模型，选出这对格子属于哪一段（开始 / 结束仍按出现顺序，不让模型定）；
 *  3. 都认不出才返回空，由调用方记缺口日志。
 */
export interface RangeFill { fieldId: string; value: string; via: 'anchor' | 'model' }

interface Period { key: SectionKey; index: number; start?: string; end?: string; desc: string }

function periodsOf(profile: Profile): Period[] {
  const out: Period[] = []
  for (const spec of SECTIONS) {
    entriesFor(spec.key, profile).forEach((e, index) => {
      if (!e.start && !e.end) return
      const name = e.school ?? e.org ?? e.name ?? ''
      out.push({ key: spec.key, index, start: e.start, end: e.end, desc: `${spec.title}·${name}（${e.start ?? '?'} ~ ${e.end ?? '?'}）` })
    })
  }
  return out
}

/** 每个起止格子在它那一对里是第几格（0 = 开始，1 = 结束）。 */
function pairPositions(fields: readonly FormField[], ids: ReadonlySet<string>): Map<string, 0 | 1> {
  const pos = new Map<string, 0 | 1>()
  let open: string | null = null
  for (const f of fields) {
    if (!ids.has(f.id)) continue
    if (open === null) { pos.set(f.id, 0); open = f.label } else { pos.set(f.id, 1); open = null }
  }
  return pos
}

function byAnchor(fields: readonly FormField[], ids: ReadonlySet<string>, periods: Period[]): RangeFill[] {
  const pos = pairPositions(fields, ids)
  const seen = new Map<SectionKey, number>()
  let last: { key: SectionKey; index: number } | null = null
  const out: RangeFill[] = []
  for (const f of fields) {
    const spec = SECTIONS.find(s => s.anchorKeys.includes(matchRowField(f.label, s) ?? ''))
    if (spec) { const n = seen.get(spec.key) ?? 0; seen.set(spec.key, n + 1); last = { key: spec.key, index: n }; continue }
    if (!ids.has(f.id) || !last) continue
    const anchor = last
    const p = periods.find(x => x.key === anchor.key && x.index === anchor.index)
    const value = pos.get(f.id) === 1 ? p?.end : p?.start
    if (value) out.push({ fieldId: f.id, value, via: 'anchor' })
  }
  return out
}

async function byModel(llm: LLM, fields: readonly FormField[], ids: ReadonlySet<string>, periods: Period[], log?: (msg: string) => void): Promise<RangeFill[]> {
  if (!periods.length) return []
  const pos = pairPositions(fields, ids)
  const page = fields.map(f => `${ids.has(f.id) ? `【${f.id}】` : ''}${f.label}`).join(' | ')
  const system = '你在帮应届生填网申表。表单里有「起止时间」这类一个标签管开始、结束两格的时间段格子（用【编号】标出）。根据整页字段的顺序和上下文，判断每一对格子属于学生资料里的哪一段经历。只输出 JSON：{"pairs":[{"first":"f17","period":序号}]}；判断不出就不写那一对。'
  const user = `整页字段（按页面顺序）：${page}\n资料里的时间段：\n${periods.map((p, i) => `${i}. ${p.desc}`).join('\n')}`
  try {
    const res = await llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0, maxTokens: 300 })
    const picked = extractJson<{ pairs?: Array<{ first?: unknown; period?: unknown }> }>(res.text).pairs ?? []
    const order = fields.filter(f => ids.has(f.id)).map(f => f.id)
    const out: RangeFill[] = []
    for (const p of picked) {
      const period = typeof p.period === 'number' ? periods[p.period] : undefined
      const at = typeof p.first === 'string' ? order.indexOf(p.first) : -1
      if (!period || at < 0 || pos.get(order[at]) !== 0) continue
      if (period.start) out.push({ fieldId: order[at], value: period.start, via: 'model' })
      if (period.end && order[at + 1] && pos.get(order[at + 1]) === 1) out.push({ fieldId: order[at + 1], value: period.end, via: 'model' })
    }
    return out
  } catch (e) {
    log?.(`[apply-gap] 起止格子交模型判断失败：${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`)
    return []
  }
}

/** 给还没填上的起止格子找值：先按锚字段，剩下的交模型。 */
export async function resolveRangeValues(fields: readonly FormField[], leftover: ReadonlySet<string>, allRanges: ReadonlySet<string>, profile: Profile, llm?: LLM, log?: (msg: string) => void): Promise<RangeFill[]> {
  const periods = periodsOf(profile)
  const anchored = byAnchor(fields, allRanges, periods).filter(r => leftover.has(r.fieldId))
  const rest = new Set([...leftover].filter(id => !anchored.some(r => r.fieldId === id)))
  if (!rest.size || !llm) return anchored
  const modeled = (await byModel(llm, fields, allRanges, periods, log)).filter(r => rest.has(r.fieldId))
  return [...anchored, ...modeled]
}
