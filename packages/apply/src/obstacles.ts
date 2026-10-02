import type { HandoffReason } from '@career/core'
import type { PageSignals } from './scripts.js'

/**
 * 阻碍分层：同一个 handoff 原因下再细分"是哪一种"，给用户说清楚该做什么，并决定风控退避。
 *  - 验证码：滑块 / 点选图 / 短信码 / 图形字符 / 浏览器环境检查（Cloudflare 类）
 *  - 风控：限流 / 异常访问 / 账号风险 → 升级退避（30 分钟 → 2 小时 → 12 小时 → 24 小时）
 */
export type CaptchaKind = 'slider' | 'image_click' | 'sms' | 'image_text' | 'browser_check' | 'unknown'
export interface ObstacleDetail { reason: HandoffReason; kind?: CaptchaKind; userAction: string }

const SLIDER_RX = /(拖动滑块|滑动验证|滑块|滑动完成拼图|向右滑动|geetest|nc_wrapper|slide to verify)/i
const IMAGE_CLICK_RX = /(点选|按顺序点击|点击图中|依次点击|请点击.*(文字|图片)|select all images)/i
const SMS_RX = /(短信验证码|手机验证码|获取验证码|发送验证码|验证码已发送|sms code|verification code sent)/i
const IMAGE_TEXT_RX = /(图形验证码|看不清|换一张|输入图中|请输入验证码)/i
const BROWSER_CHECK_RX = /(checking your browser|just a moment|cf-turnstile|turnstile|verify you are human|not a robot|recaptcha|hcaptcha)/i

export function classifyCaptcha(sig: Pick<PageSignals, 'title' | 'text'> & { captchaDom?: boolean }, evidence = ''): CaptchaKind {
  const text = `${sig.title} ${sig.text} ${evidence}`
  if (BROWSER_CHECK_RX.test(text)) return 'browser_check'
  if (SLIDER_RX.test(text)) return 'slider'
  if (IMAGE_CLICK_RX.test(text)) return 'image_click'
  if (SMS_RX.test(text)) return 'sms'
  if (IMAGE_TEXT_RX.test(text)) return 'image_text'
  return 'unknown'
}

const CAPTCHA_ACTIONS: Record<CaptchaKind, string> = {
  slider: '请在浏览器里拖动滑块完成验证，然后点"交还"继续',
  image_click: '请在浏览器里按提示点选图片 / 文字完成验证，然后点"交还"继续',
  sms: '请查看手机短信，在浏览器里输入验证码，然后点"交还"继续',
  image_text: '请在浏览器里输入图形验证码，然后点"交还"继续',
  browser_check: '网站在做浏览器环境检查，请在浏览器里等待或点一下验证框，通过后点"交还"继续',
  unknown: '请在浏览器里完成验证，然后点"交还"继续',
}

/** 把 detectObstacle 的结果翻译成用户该做什么。 */
export function describeObstacle(reason: HandoffReason, sig: Pick<PageSignals, 'title' | 'text'> & { captchaDom?: boolean }, evidence = '', extra: { loginFilled?: readonly string[] } = {}): ObstacleDetail {
  switch (reason) {
    case 'captcha': { const kind = classifyCaptcha(sig, evidence); return { reason, kind, userAction: CAPTCHA_ACTIONS[kind] } }
    case 'login': return { reason, userAction: extra.loginFilled?.length ? `账号${extra.loginFilled.includes('password') ? '和密码' : ''}已代填，请在浏览器里点击登录并完成验证，然后点"交还"继续` : '请在浏览器里登录（扫码 / 账号密码 / 短信码均可），登录成功后点"交还"继续' }
    case '2fa': return { reason, userAction: '请在浏览器里完成二次验证（验证器 / 短信 / 邮箱），然后点"交还"继续' }
    case 'assessment': return { reason, userAction: '这是需要本人作答的测评 / 笔试，请在浏览器里自行完成；完成后点"交还"，助理会继续后面的表单' }
    case 'submit_confirm': return { reason, userAction: '表单已填好，请在浏览器里检查一遍并由你本人点击提交' }
    case 'missing_info': return { reason, userAction: '有几项资料缺失或需要你确认，请在对话里补充后再继续' }
    default: return { reason, userAction: '请在浏览器里处理后点"交还"继续' }
  }
}

/** 风控退避：同一平台当天第 n 次触发风控的锁定分钟数。 */
export const RISK_BACKOFF_MINUTES = [30, 120, 720, 1440] as const
export function riskBackoffMinutes(tripIndex: number): number {
  return RISK_BACKOFF_MINUTES[Math.min(Math.max(0, tripIndex), RISK_BACKOFF_MINUTES.length - 1)]
}

/** 风控类 URL：被重定向到验证 / 风险页也算触发。 */
export const RISK_URL_RX = /\/(verify|verification|captcha|risk|security-check|challenge|blocked|abuse|antibot)(\/|$|\?|#|-)/i
export function looksLikeRiskUrl(url: string): boolean { return RISK_URL_RX.test(url) }
