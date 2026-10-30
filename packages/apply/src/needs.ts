import type { FieldPlan } from './interpret.js'
import { normKey } from './text.js'

/**
 * 收尾时整理「要你补」：多轮扫描（新出现的格子、整表重渲染后重新抽取）会把同一格记好几次，
 * 前一轮没填上、后一轮已经填好的格子也还留在单子里——学生会被要求补已经办完的事（2026-10-31 小鹏：横幅写「还差 10 项」，实际 7 项）。
 * 同一格 = 同一个编号 + 同一个标签（重新抽取按页面顺序编号，同一格编号不变）；标签相同、编号不同的是两个格子（两段教育经历各有一个「学历」），都留着。
 * 规则：已经核验填好的格子去掉；同一格只留最后一次（最新的原因）。
 */
const slot = (p: { fieldId: string; label: string }) => `${p.fieldId}\u0001${normKey(p.label)}`

export function settleNeedsUser(needs: readonly FieldPlan[], filled: ReadonlyArray<{ fieldId: string; label: string; verified?: boolean }>): FieldPlan[] {
  const done = new Set(filled.filter(f => f.verified).map(slot))
  const last = new Map<string, FieldPlan>()
  for (const p of needs) {
    const key = slot(p)
    if (done.has(key)) continue
    last.delete(key)
    last.set(key, p)
  }
  return [...last.values()]
}
