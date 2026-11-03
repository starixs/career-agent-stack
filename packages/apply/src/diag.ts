import type { PageLike } from './page.js'
import type { Recorder } from './telemetry.js'
import { domSnippetScript } from './widgets.js'

/**
 * 交给人补的字段各留一份表单项 DOM（打码、截断）：复盘时能看清这些格子长什么样、为什么没认出 / 没值可填。
 * 2026-10-31 小鹏（飞书）：「推荐方式」标签带进了选项文字、9 个格子标签认不出，运行记录里却没有它们的结构可查。
 */

/** 一次最多留几份：够覆盖一页表单里交给人补的格子，又不让运行记录膨胀（单份上限见 telemetry.dom）。 */
export const NEEDS_SNAPSHOT_MAX = 16

export async function snapshotNeedsUser(page: PageLike, recorder: Recorder, needs: ReadonlyArray<{ fieldId: string; label: string }>): Promise<number> {
  const seen = new Set<string>()
  let saved = 0
  for (const n of needs) {
    if (seen.has(n.fieldId) || saved >= NEEDS_SNAPSHOT_MAX) continue
    seen.add(n.fieldId)
    try {
      const html = await page.evaluate(domSnippetScript, { selector: `[data-career-field="${n.fieldId}"]` })
      if (html && recorder.dom(`needs-${n.fieldId}-${n.label}`, html)) saved++
    } catch (e) {
      recorder.trace({ stage: 'diag', action: 'snapshot', field: n.fieldId, label: n.label, result: 'fail', detail: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) })
    }
  }
  return saved
}
