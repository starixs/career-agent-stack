import type { PageLike } from './page.js'
import { extractFields, type FormField } from './extract.js'

/**
 * 登录页代填：把私密库里的账号 / 密码填进登录表单，**不点登录、不碰验证码**。
 * 纯确定性（label / name / placeholder 关键词匹配），不经过模型；凭证只在 Node 侧流转。
 * 登录本身仍由用户本人完成（点击登录、滑块、短信码），与产品契约"登录交给用户"一致。
 */
export interface LoginCredential { username?: string; password?: string }
export interface LoginFillResult { filled: Array<'username' | 'password'>; skipped: string[] }

export const PASSWORD_RX = /(密码|password|passwd|pwd)/i
export const USERNAME_RX = /(用户名|账号|帐号|账户|帐户|手机号|手机|邮箱|邮件|登录名|login|account|username|user ?name|phone|mobile|email|uid)/i
const CAPTCHA_FIELD_RX = /(验证码|captcha|verify|code)/i

const keyOf = (f: FormField) => `${f.label} ${f.name ?? ''} ${f.placeholder ?? ''}`

export function pickLoginFields(fields: FormField[]): { username?: FormField; password?: FormField } {
  const textish = fields.filter(f => ['text', 'email', 'tel'].includes(f.type) && !f.isFile)
  const password = textish.find(f => PASSWORD_RX.test(keyOf(f)) && !CAPTCHA_FIELD_RX.test(keyOf(f)))
  const candidates = textish.filter(f => f !== password && !CAPTCHA_FIELD_RX.test(keyOf(f)) && !PASSWORD_RX.test(keyOf(f)))
  const username = candidates.find(f => USERNAME_RX.test(keyOf(f))) ?? (password && candidates.length === 1 ? candidates[0] : undefined)
  return { username, password }
}

export async function fillLoginForm(page: PageLike, cred: LoginCredential): Promise<LoginFillResult> {
  const fields = await extractFields(page)
  const { username, password } = pickLoginFields(fields)
  const out: LoginFillResult = { filled: [], skipped: [] }
  if (cred.username) {
    if (username) { await page.fill(username.selector, cred.username); out.filled.push('username') }
    else out.skipped.push('页面上没找到账号输入框')
  }
  if (cred.password) {
    if (password) { await page.fill(password.selector, cred.password); out.filled.push('password') }
    else out.skipped.push('页面上没找到密码输入框（可能是验证码登录）')
  }
  return out
}
