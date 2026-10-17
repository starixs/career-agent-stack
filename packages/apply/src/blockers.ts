import { extractJson, type LLM } from '@career/core'
import type { PageLike } from './page.js'
import { scanDialogsScript, type DialogButton, type DialogInfo } from './widgets.js'
import type { Recorder } from './telemetry.js'

/**
 * 障碍层：页面上弹出来挡路的模态框 / 遮罩 / cookie 横幅。
 *  第一重（做好）：已知规则直接选安全按钮（"是否解析简历附件并填充" → 否 / 仅上传；cookie → 仅必要 / 关闭；
 *                  温馨提示 / 须知 → 我知道了 / 关闭），未知的交给模型在按钮里选一个；
 *  第二重（兜底）：任何涉及提交、同意协议、授权、付费、删除、覆盖资料的按钮都不点，模型选了也不点，交给用户；
 *                  点完必须核验弹窗真的消失了。
 */
export interface HandledBlocker { text: string; choice?: string; by: 'rule' | 'llm' | 'none'; rule?: string; resolved: boolean; reason?: string }
export interface BlockerOutcome { handled: HandledBlocker[]; unresolved?: { text: string; buttons: string[]; reason: string } }
export interface BlockerContext {
  llm?: LLM
  recorder?: Recorder
  progress?: (message: string) => void
  log?: (message: string) => void
  /** 点击后等待弹窗消失的毫秒数。 */
  settleMs?: number
  maxRounds?: number
  stage?: string
}

/** 永不自动点的按钮文案（以及模型选了也不点）。 */
export const UNSAFE_BUTTON_RX = /(提交|投递|申请|同意|授权|签署|接受协议|支付|付费|购买|充值|下单|删除|移除|清空|注销|解绑|覆盖|退出登录|放弃|解析|同步更新|是，需|确认提交|开通|订阅)/
/** 弹窗正文里出现这些，就只允许"关闭 / 取消 / 稍后"类按钮。 */
const RISKY_DIALOG_RX = /(删除|清空|覆盖|提交|投递|支付|付费|授权|签署|注销|放弃|不可恢复|无法恢复)/
const CLOSE_LIKE_RX = /^(关闭|取消|×|✕|x|稍后|以后再说|暂不|暂不需要|跳过|我知道了|知道了|不用了|close|cancel|later|skip|not now|dismiss)$/i

const RESUME_PARSE_RX = /((解析|识别).{0,14}(简历|附件))|((简历|附件).{0,14}(解析|识别|自动填充|填充))|同步更新简历|覆盖.{0,6}(已填|简历)/
const RESUME_PARSE_SAFE_RX = /(仅.{0,6}上传|否|不解析|不需要|暂不|不同步|不覆盖|跳过|取消)/
const COOKIE_MIN_RX = /(仅.{0,4}必要|只.{0,4}必要|拒绝|reject|necessary only|essential only|only necessary)/i
const COOKIE_ACCEPT_RX = /^(接受|同意|允许|接受全部|同意并继续|accept|accept all|agree|ok|allow)$/i
const NOTICE_RX = /(温馨提示|须知|提示|公告|注意事项|说明|通知|重要提醒|友情提示|tips)/i
const NOTICE_OK_RX = /^(我知道了|知道了|我已知晓|已知晓|好的|好|关闭|确定|确认|ok|got it|i see)$/i

const squash = (s: string) => s.replace(/\s+/g, '').trim()

export function isUnsafeButton(text: string): boolean { return UNSAFE_BUTTON_RX.test(squash(text)) }

/** 已知规则：返回要点的按钮与规则名；拿不准返回 null。 */
export function decideByRule(d: DialogInfo): { button: DialogButton; rule: string } | null {
  const text = d.text
  const find = (rx: RegExp, guard = true) => d.buttons.find(b => rx.test(squash(b.text)) && (!guard || !isUnsafeButton(b.text)))
  if (RESUME_PARSE_RX.test(text)) {
    // "否，仅做附件上传"：解析会用简历内容覆盖待填的值，我们自己按资料逐项填
    const b = d.buttons.find(x => /仅.{0,6}上传/.test(squash(x.text))) ?? find(RESUME_PARSE_SAFE_RX, false)
    if (b && !/是|需|同步|解析并/.test(squash(b.text).replace(/不解析|不同步/g, ''))) return { button: b, rule: 'resume_parse_decline' }
    return null
  }
  if (d.kind === 'cookie') {
    const min = find(COOKIE_MIN_RX, false)
    if (min) return { button: min, rule: 'cookie_minimal' }
    const close = find(CLOSE_LIKE_RX)
    if (close) return { button: close, rule: 'cookie_close' }
    const accept = d.buttons.find(b => COOKIE_ACCEPT_RX.test(squash(b.text)))
    if (accept) return { button: accept, rule: 'cookie_accept' }
    return null
  }
  if (NOTICE_RX.test(text) && !RISKY_DIALOG_RX.test(text)) {
    const b = find(NOTICE_OK_RX)
    if (b) return { button: b, rule: 'notice_ack' }
  }
  return null
}

/** 安全复核：规则或模型选出的按钮能不能点。 */
export function isSafeChoice(d: DialogInfo, b: DialogButton, rule?: string): boolean {
  if (rule === 'cookie_accept' || rule === 'resume_parse_decline') return true
  if (isUnsafeButton(b.text)) return false
  if (RISKY_DIALOG_RX.test(d.text) && !CLOSE_LIKE_RX.test(squash(b.text))) return false
  return true
}

async function decideByLlm(llm: LLM, d: DialogInfo): Promise<{ index: number | null; reason: string }> {
  const system = `你在帮用户填写网申表单，页面上弹出了一个对话框挡住了表单。请在按钮里选一个"安全"的：只关闭提示 / 拒绝可选项 / 不改动用户已有资料的那个。
绝对不选：提交、投递、同意协议或授权、付费、删除、覆盖或同步资料、解析简历并填充。拿不准就返回 null。
只输出 JSON：{"choice": 按钮序号或 null, "reason": "一句话"}`
  const user = JSON.stringify({ dialog: d.text.slice(0, 400), buttons: d.buttons.map((b, i) => ({ i, text: b.text })) })
  try {
    const res = await llm.complete({ system, messages: [{ role: 'user', content: user }], json: true, temperature: 0, maxTokens: 200 })
    const j = extractJson<{ choice?: number | null; reason?: string }>(res.text)
    const i = typeof j.choice === 'number' && Number.isInteger(j.choice) && j.choice >= 0 && j.choice < d.buttons.length ? j.choice : null
    return { index: i, reason: j.reason ?? '' }
  } catch (e) { return { index: null, reason: `模型不可用：${e instanceof Error ? e.message : String(e)}` } }
}

/**
 * 扫一遍并处理挡路的弹窗。返回处理记录；有处理不了的模态弹窗时 unresolved 说明原因（调用方交给用户）。
 * 非模态的横幅只在有已知规则时处理，不调用模型、不阻塞。
 */
export async function clearBlockers(page: PageLike, ctx: BlockerContext = {}): Promise<BlockerOutcome> {
  const handled: HandledBlocker[] = []
  const tried = new Map<string, number>()
  const rounds = ctx.maxRounds ?? 4
  for (let round = 0; round < rounds; round++) {
    let scan
    try { scan = await page.evaluate(scanDialogsScript) } catch { return { handled } }
    const pending = scan.dialogs.filter(d => d.buttons.length || d.modal)
    if (!pending.length) return { handled }
    const d = pending.find(x => x.modal) ?? pending[0]
    const key = d.text.slice(0, 80)
    const attempts = tried.get(key) ?? 0
    if (attempts >= 2) {
      const rec: HandledBlocker = { text: d.text, by: 'none', resolved: false, reason: '点了按钮弹窗还在' }
      handled.push(rec); ctx.recorder?.trace({ stage: ctx.stage ?? 'blocker', action: 'dialog', result: 'fail', code: 'blocker_persist', detail: d.text })
      return d.modal ? { handled, unresolved: { text: d.text, buttons: d.buttons.map(b => b.text), reason: '点了安全按钮之后弹窗仍然没有消失' } } : { handled }
    }
    tried.set(key, attempts + 1)
    let choice: DialogButton | undefined
    let by: HandledBlocker['by'] = 'none'
    let rule: string | undefined
    let why = ''
    const r = decideByRule(d)
    if (r && isSafeChoice(d, r.button, r.rule)) { choice = r.button; by = 'rule'; rule = r.rule }
    else if (d.modal && ctx.llm && d.buttons.length) {
      const pick = await decideByLlm(ctx.llm, d)
      why = pick.reason
      const b = pick.index === null ? undefined : d.buttons[pick.index]
      if (b && isSafeChoice(d, b)) { choice = b; by = 'llm' }
      else if (b) why = `模型选了「${b.text}」，不在安全范围内，没有点`
    }
    if (!choice) {
      ctx.recorder?.trace({ stage: ctx.stage ?? 'blocker', action: 'dialog', result: 'fail', code: 'blocker_unknown', detail: `${d.text} | 按钮：${d.buttons.map(b => b.text).join(' / ')} | ${why}` })
      if (!d.modal) return { handled } // 非模态横幅：不挡就不管
      handled.push({ text: d.text, by: 'none', resolved: false, reason: why || '不确定该点哪个按钮' })
      return { handled, unresolved: { text: d.text, buttons: d.buttons.map(b => b.text), reason: why || '不确定该点哪个按钮，可能涉及同意协议或改动资料' } }
    }
    try { await page.click(choice.selector) } catch (e) {
      ctx.recorder?.trace({ stage: ctx.stage ?? 'blocker', action: 'click', result: 'fail', code: 'blocker_click_failed', detail: `${choice.text}: ${e instanceof Error ? e.message : String(e)}` })
      continue
    }
    await page.waitForTimeout(ctx.settleMs ?? 400)
    let gone = true
    try { gone = !(await page.evaluate(scanDialogsScript)).dialogs.some(x => x.text.slice(0, 80) === key) } catch { /* 页面跳走了算消失 */ }
    const rec: HandledBlocker = { text: d.text, choice: choice.text, by, rule, resolved: gone }
    handled.push(rec)
    ctx.recorder?.trace({ stage: ctx.stage ?? 'blocker', action: 'dialog', strategy: by === 'rule' ? `rule:${rule}` : 'llm', result: gone ? 'ok' : 'fail', detail: `${d.text.slice(0, 120)} → 「${choice.text}」` })
    if (gone) ctx.progress?.(`弹窗：已选「${choice.text}」`)
    ctx.log?.(`障碍层：${d.text.slice(0, 40)} → ${choice.text}（${by}${rule ? ':' + rule : ''}）${gone ? '' : '，弹窗还在'}`)
  }
  return { handled }
}
