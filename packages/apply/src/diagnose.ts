import { handoffReasonLabel, type HandoffReason } from '@career/core'
import type { PageLike } from './page.js'
import { extractFields } from './extract.js'
import { pageSignalsScript } from './scripts.js'
import { detectObstacle, detectRateLimit, isSubmitText, isNextText } from './guards.js'
import { pickAdapter, type SiteAdapter } from './adapters/index.js'

/** 预检结果：开跑前先看一眼，决定走 / 不走 / 先让用户登录。 */
export interface Diagnosis {
  reachable: boolean
  url: string
  title: string
  adapterId: string
  needsLogin: boolean
  obstacle?: HandoffReason
  obstacleEvidence?: string
  antiBotHint?: string
  fieldCount: number
  requiredCount: number
  hasFileUpload: boolean
  hasSubmitButton: boolean
  hasNextButton: boolean
  looksLikeForm: boolean
  notes: string[]
}

export async function diagnosePage(page: PageLike, opts: { url?: string; adapter?: SiteAdapter } = {}): Promise<Diagnosis> {
  const notes: string[] = []
  if (opts.url) {
    try { await page.goto(opts.url) } catch (e) {
      return { reachable: false, url: opts.url, title: '', adapterId: (opts.adapter ?? pickAdapter(opts.url)).id, needsLogin: false, fieldCount: 0, requiredCount: 0, hasFileUpload: false, hasSubmitButton: false, hasNextButton: false, looksLikeForm: false, notes: [`页面不可达：${e instanceof Error ? e.message : String(e)}`] }
    }
  }
  const adapter = opts.adapter ?? pickAdapter(page.url())
  const sig = await page.evaluate(pageSignalsScript)
  const ob = detectObstacle(sig, adapter)
  const rl = detectRateLimit(`${sig.title} ${sig.text}`)
  let fields = [] as Awaited<ReturnType<typeof extractFields>>
  try { fields = await extractFields(page) } catch (e) { notes.push(`抽取失败：${e instanceof Error ? e.message : String(e)}`) }
  const hasSubmit = sig.buttons.some(b => isSubmitText(b.text, adapter))
  const hasNext = sig.buttons.some(b => isNextText(b.text, adapter))
  const required = fields.filter(f => f.required).length
  const hasFile = fields.some(f => f.isFile) || sig.fileInputs > 0
  const looksLikeForm = fields.length >= 2 && (hasFile || fields.some(f => /姓名|手机|邮箱|name|phone|email/i.test(f.label)) || required > 0)
  if (ob) notes.push(`检测到阻碍：${handoffReasonLabel(ob.reason)}（${ob.evidence}）`)
  if (rl) notes.push(`反爬 / 限流提示：${rl}`)
  if (!fields.length) notes.push('没有抽到任何字段：可能是职位详情页而非网申表单，或表单在 iframe / 需点击"申请"后出现')
  if (fields.length && !looksLikeForm) notes.push('字段像搜索/筛选框而不是网申表单')
  if (hasFile) notes.push('有文件上传：会先传简历再核对解析结果')
  if (hasNext && !hasSubmit) notes.push('多页表单：会逐页填写，停在提交前')
  return {
    reachable: true, url: sig.url || page.url(), title: sig.title, adapterId: adapter.id,
    needsLogin: ob?.reason === 'login', obstacle: ob?.reason, obstacleEvidence: ob?.evidence, antiBotHint: rl ?? (ob?.reason === 'captcha' ? ob.evidence : undefined),
    fieldCount: fields.length, requiredCount: required, hasFileUpload: hasFile, hasSubmitButton: hasSubmit, hasNextButton: hasNext, looksLikeForm, notes,
  }
}
