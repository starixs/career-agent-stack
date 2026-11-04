import { extractFields } from './extract.js'
import type { FieldPlan } from './interpret.js'
import type { PageLike } from './page.js'
import { normKey } from './text.js'
import { closePopupScript, openOptionsScript } from './widgets.js'

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

/** 一格最多带多少个选项给学生：够装下省份 / 国家这类长列表，又不至于把卡片撑爆（卡片里多了就变成输入时提示）。 */
export const ASK_OPTIONS_MAX = 300

/**
 * 问学生之前先把要他补的下拉 / 单选的选项读出来（点开就收起），跟着问题带过去：学生点选就行，
 * 不用猜网站写的是「中国大陆」还是「中国」、是「统招全日制」还是「全日制」（2026-10-31 小鹏等你卡全是空白输入框）。
 * 列表只渲染了一部分（虚拟滚动）时不带——带一半选项会误导；读不到也不影响原来的问法。
 */
export async function attachOptions(page: PageLike, needs: readonly FieldPlan[], log?: (msg: string) => void): Promise<FieldPlan[]> {
  if (!needs.length) return [...needs]
  let fields: Awaited<ReturnType<typeof extractFields>> = []
  try { fields = await extractFields(page) } catch (e) { log?.(`读要你补的格子的选项失败：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`); return [...needs] }
  const out: FieldPlan[] = []
  for (const p of needs) {
    const f = fields.find(x => x.id === p.fieldId && normKey(x.label) === normKey(p.label))
    if (!f || (f.type !== 'select' && f.type !== 'radio')) { out.push(p); continue }
    let options = f.options.filter(Boolean)
    if (!options.length && f.type === 'select') {
      try {
        const open = await page.evaluate(openOptionsScript, { selector: f.selector })
        options = open.partial ? [] : open.options.filter(o => !o.disabled).map(o => o.text)
      } catch (e) { log?.(`点开「${f.label}」读选项失败：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`) }
      await page.evaluate(closePopupScript, { selector: f.selector }).catch((e: unknown) => log?.(`收起「${f.label}」失败：${e instanceof Error ? e.message.slice(0, 80) : String(e)}`))
    }
    out.push(options.length && options.length <= ASK_OPTIONS_MAX ? { ...p, options } : p)
  }
  return out
}

const fieldNo = (id: string) => Number(id.replace(/\D/g, '')) || 0

/**
 * 灰着的格子是在等前面的格子（先选学院才能选专业、先选意向部门才能选城市）：说清在等哪一格，
 * 这一格不问他——前一格一定，续填时自动接上（2026-11-02 美团：专业名称、意向城市都以「这一格是灰的」推给了用户）。
 * 前面没有还空着的格子（网站锁定了），照旧报灰。
 */
export function explainWaiting(needs: FieldPlan[]): FieldPlan[] {
  const sorted = [...needs].sort((a, b) => fieldNo(a.fieldId) - fieldNo(b.fieldId))
  return needs.map(n => {
    if (n.code !== 'field_disabled') return n
    const before = sorted.filter(o => o.code !== 'field_disabled' && fieldNo(o.fieldId) < fieldNo(n.fieldId))
    const parent = before[before.length - 1]
    return parent ? { ...n, waitsFor: parent.label, note: `要先定「${parent.label}」，定了我接着填` } : n
  })
}
