import type { PageLike } from './page.js'
import { pageSignalsScript, type PageSignals } from './scripts.js'
import { detectObstacle, detectRateLimit } from './guards.js'

/** 宿主负责验证码通道与私密信息；引擎只接收状态，不接收码或消息正文。 */
export interface VerificationResult {
  status: 'unchanged' | 'changed' | 'needs_user'
  message?: string
}
export type VerificationHandler = (signals: PageSignals) => Promise<VerificationResult>

/** 填前和翻页前共用；限流、验证器及测评不能被自动验证钩子吃掉。 */
export async function verifyBeforeContinuing(page: PageLike, signals: PageSignals, handler?: VerificationHandler): Promise<{ signals: PageSignals; blocked: boolean }> {
  const reason = detectObstacle(signals)?.reason
  if (!handler || reason === '2fa' || reason === 'assessment' || detectRateLimit(signals.text)) return { signals, blocked: false }
  try {
    const result = await handler(signals)
    return { signals: result.status === 'changed' ? await page.evaluate(pageSignalsScript) : signals, blocked: result.status === 'needs_user' }
  } catch {
    // 不传播第三方错误正文：其中可能包含输入值或邮箱凭证。
    console.warn('[apply-verification] handler failed; handing back to user')
    return { signals, blocked: true }
  }
}
