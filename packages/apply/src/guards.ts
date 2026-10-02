import type { HandoffReason } from '@career/core'
import type { SiteAdapter } from './adapters/types.js'
import type { PageSignals } from './scripts.js'

/**
 * 提交守卫：命中即一律停止，绝不点击。动作集里没有"提交"这个动作，
 * 这里只是最后一道防线（按钮文案层面）。
 */
export const SUBMIT_RX = /(确认提交|提交申请|提交简历|提交报名|提交表单|立即提交|提交|确认投递|立即投递|投递简历|投递|立即申请|申请职位|确认发送|发送简历|\bsubmit\b|apply now|send application|finish application|complete application|\bfinish\b)/i

/** "下一步"类按钮。注意不能命中提交词（先过 SUBMIT_RX）。 */
export const NEXT_RX = /^(保存并下一步|保存并继续|保存并前往下一步|下一步|下一页|继续填写|继续|next( step)?|continue|save (and|&) continue)$/i

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const nospace = (s: string) => s.replace(/\s+/g, '')

export function isSubmitText(text: string, adapter?: SiteAdapter): boolean {
  const t = squash(text); const tz = nospace(text)
  if (SUBMIT_RX.test(t) || SUBMIT_RX.test(tz)) return true
  for (const w of adapter?.hints.submitWords ?? []) if (tz.includes(nospace(w))) return true
  return false
}

export function isNextText(text: string, adapter?: SiteAdapter): boolean {
  if (isSubmitText(text, adapter)) return false
  const t = squash(text); const tz = nospace(text)
  if (NEXT_RX.test(t) || NEXT_RX.test(tz)) return true
  for (const w of adapter?.hints.nextButton ?? []) if (tz === nospace(w)) return true
  return false
}

export interface Obstacle { reason: HandoffReason; evidence: string }

const TWO_FA_RX = /(二次验证|两步验证|双重验证|身份验证器|动态口令|two-?factor|\b2fa\b|authenticator)/i
const CAPTCHA_STRONG_RX = /(拖动滑块|滑动验证|滑块验证|滑动完成拼图|人机验证|安全验证|请完成验证|图形验证码|点选验证|按顺序点击|captcha|verify (you are|that you're|you're) human|not a robot|checking your browser|just a moment|异常访问行为|访问频繁|操作频繁)/i
const LOGIN_RX = /(请先登录|登录后继续|登录后投递|登录后申请|扫码登录|账号密码登录|账号登录|密码登录|验证码登录|手机号登录|登录\s*\/\s*注册|sign in to continue|log ?in to continue|please (sign|log) ?in)/i
const LOGIN_URL_RX = /\/(login|signin|sign-in|passport|auth|sso|register|signup)(\/|$|\?|#)/i
const ASSESSMENT_RX = /(在线测评|性格测评|职业测评|能力测评|测评题|答题时间|请在\s*\d+\s*分钟内完成|assessment)/i
const CAPTCHA_WEAK_RX = /(验证码)/i

/**
 * 阻碍检测（关键词 + DOM 启发式）。命中就交给用户本人，绝不自动绕过。
 * 顺序：2FA → 强验证码信号 → 登录墙 → 测评 → 弱验证码信号。
 */
export function detectObstacle(sig: Pick<PageSignals, 'url' | 'title' | 'text' | 'hasPasswordInput' | 'captchaDom'>, adapter?: SiteAdapter): Obstacle | null {
  const text = `${sig.title} ${sig.text}`
  const hit = (rx: RegExp) => { const m = text.match(rx); return m ? m[0] : null }
  const lower = text.toLowerCase()
  const contains = (words: string[] | undefined) => (words ?? []).find(w => w && lower.includes(w.toLowerCase())) ?? null

  const twofa = hit(TWO_FA_RX); if (twofa) return { reason: '2fa', evidence: twofa }
  if (sig.captchaDom) return { reason: 'captcha', evidence: '页面存在验证码 / 滑块控件' }
  const cap = hit(CAPTCHA_STRONG_RX) ?? contains(adapter?.hints.captchaIndicators); if (cap) return { reason: 'captcha', evidence: cap }
  if (sig.hasPasswordInput) return { reason: 'login', evidence: '页面有密码输入框' }
  if (LOGIN_URL_RX.test(sig.url)) return { reason: 'login', evidence: `URL 像登录页：${sig.url}` }
  const login = hit(LOGIN_RX) ?? contains(adapter?.hints.loginIndicators); if (login) return { reason: 'login', evidence: login }
  const assess = hit(ASSESSMENT_RX); if (assess) return { reason: 'assessment', evidence: assess }
  const weak = hit(CAPTCHA_WEAK_RX); if (weak && !/短信|手机|邮箱/.test(text)) return { reason: 'captcha', evidence: weak }
  return null
}

/** 限流 / 封禁提示（不属于 HandoffReason，但要立刻停）。 */
export const RATE_LIMIT_RX = /(访问过于频繁|操作过于频繁|请求过于频繁|请稍后再试|访问受限|异常访问|too many requests|rate limit|\b429\b|账号异常|账号存在风险)/i
export function detectRateLimit(text: string): string | null { const m = text.match(RATE_LIMIT_RX); return m ? m[0] : null }
