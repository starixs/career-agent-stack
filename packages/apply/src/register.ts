import type { PageLike } from './page.js'
import { extractFields, type FormField } from './extract.js'
import { AGREE_RX, captchaOnPage, clickText, CODE_FIELD_RX, codeFieldOf, confirmSent, keyOf, openLogin, OTHER_LOGIN_RX, PASSWORD_RX, switchFromQrLogin, walkUntil } from './login.js'
import { findImageCode } from './image-code.js'
import { pageSignalsScript } from './scripts.js'

/**
 * 邮箱注册（2026-11-03 用户：「有的需要注册，你可以全自动完成的就全自动完成」，例：中国中车 HotJob）：
 * 登录框默认只给微信扫码 → 点角标切到账号登录 → 「立即注册」→ 填邮箱、密码、勾协议、点「获取邮箱激活码」；
 * 激活码由调用方从他连着的邮箱里读出来，submitRegisterCode 填上并点「注册」。他一下都不用碰。
 * 密码由调用方生成并存进私密库（这个站的账号），以后登录直接代填。
 */

const REGISTER_RX = '^(立即注册|注册|免费注册|注册账号|去注册|新用户注册|注册新账号)$'
const SEND_MAIL_CODE_RX = '^(获取邮箱激活码|获取激活码|发送激活码|获取邮箱验证码|发送邮箱验证码|获取验证码|发送验证码)$'
const REGISTER_BUTTON_RX = '^(注册|立即注册|完成注册|注册并登录|登录|立即登录|登录/注册|确定|提交)$'
/** 邮箱验证码登录的标签（中国中车：切过去是「密码登录 / 验证码登录」，验证码登录「首次登录将自动创建账号」）。 */
const CODE_LOGIN_TAB_RX = '^(验证码登录|邮箱验证码登录|免密登录|动态码登录)$'
/** 邮箱登录的标签：走邮箱这条路先点它（2026-11-03 畅游 Moka：OTHER_LOGIN_RX 里也有「手机号登录」，会点回默认的手机号标签）。 */
const EMAIL_LOGIN_TAB_RX = '^(邮箱登录|使用邮箱登录|邮箱账号登录|邮箱验证码登录)$'
const EMAIL_FIELD_RX = /(邮箱|e-?mail|mail)/i
/** 点了获取验证码后等图形码弹出来。 */
const IMAGE_CODE_WAIT_MS = 1000

export type RegisterPrepareResult =
  | { status: 'sent'; agreed: boolean; /** false：邮箱验证码登录，没设密码 */ withPassword: boolean }
  | { status: 'captcha'; evidence: string }
  /** 点了获取验证码弹出图形码：要他看图打字（answerImageCode），之后照常收码 */
  | { status: 'image_code'; withPassword: boolean }
  | { status: 'no_register'; reason: string }

const emailFieldOf = (fields: FormField[]) => fields.find(f => ['text', 'email'].includes(f.type) && EMAIL_FIELD_RX.test(keyOf(f)) && !CODE_FIELD_RX.test(keyOf(f)) && !PASSWORD_RX.test(keyOf(f)))
const passwordFieldsOf = (fields: FormField[]) => fields.filter(f => f.type === 'text' && PASSWORD_RX.test(keyOf(f)) && !CODE_FIELD_RX.test(keyOf(f)))
/** 邮箱 + 验证码（+ 密码）：有密码格是注册，没有是邮箱验证码登录（首次登录自动建号）——两种都只要邮箱里的码。 */
const registerFormOf = (fields: FormField[]) => {
  const email = emailFieldOf(fields), code = codeFieldOf(fields), passwords = passwordFieldsOf(fields)
  return email && code ? { email, code, passwords } : null
}

/** 页面上有「获取邮箱激活码」才算注册表单——登录框也有「邮箱 + 图形验证码 + 密码」三格（中国中车）。 */
async function sendCodeShown(page: PageLike): Promise<boolean> {
  const sig = await page.evaluate(pageSignalsScript)
  return new RegExp(SEND_MAIL_CODE_RX.slice(1, -1)).test(`${sig.text} ${sig.buttons.map(b => b.text).join(' ')}`)
}

/**
 * 一步步往注册表单走，每步之后看一眼到没到：扫码框切账号 → 点「立即注册」；还不行就先打开登录框再来一遍。
 * 先不点「登录」：登录框已经开着时那个字是提交按钮。
 */
async function reachRegisterForm(page: PageLike, sleep: (ms: number) => Promise<void>): Promise<ReturnType<typeof registerFormOf>> {
  const steps: Array<() => Promise<unknown>> = [
    () => clickText(page, EMAIL_LOGIN_TAB_RX), () => switchFromQrLogin(page), () => clickText(page, OTHER_LOGIN_RX), () => clickText(page, EMAIL_LOGIN_TAB_RX), () => clickText(page, CODE_LOGIN_TAB_RX), () => clickText(page, REGISTER_RX),
    () => openLogin(page), () => clickText(page, EMAIL_LOGIN_TAB_RX), () => switchFromQrLogin(page), () => clickText(page, OTHER_LOGIN_RX), () => clickText(page, EMAIL_LOGIN_TAB_RX), () => clickText(page, CODE_LOGIN_TAB_RX), () => clickText(page, REGISTER_RX),
  ]
  // 「获取邮箱激活码」只在页面文字里，判断到没到要多看一眼页面：每走一步一起看
  let shown = await sendCodeShown(page)
  const fields = await walkUntil(page, steps.map(step => async () => { const moved = await step(); shown = await sendCodeShown(page); return moved }), f => !!registerFormOf(f) && shown, sleep)
  return shown ? registerFormOf(fields) : null
}

export async function prepareEmailRegister(page: PageLike, account: { email: string; password: string }, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<RegisterPrepareResult> {
  const sleep = opts.sleep ?? (ms => page.waitForTimeout(ms))
  const form = await reachRegisterForm(page, sleep)
  if (!form) return { status: 'no_register', reason: '没找到「邮箱 + 验证码」的注册 / 登录表单' }
  await page.fill(form.email.selector, account.email)
  for (const p of form.passwords) await page.fill(p.selector, account.password) // 「确认密码」也是同一个
  const agreed = !!(await clickText(page, AGREE_RX, true))
  let sent: string | null
  try { sent = await clickText(page, SEND_MAIL_CODE_RX, false, form.code.selector) } catch (e) {
    const cap = await captchaOnPage(page)
    if (cap) return { status: 'captcha', evidence: cap }
    throw e
  }
  if (!sent) return { status: 'no_register', reason: '没找到「获取邮箱激活码」' }
  await sleep(IMAGE_CODE_WAIT_MS)
  if (await findImageCode(page)) return { status: 'image_code', withPassword: form.passwords.length > 0 }
  const after = await confirmSent(page, sleep)
  if (after.status === 'captcha') return after
  return after.status === 'sent' ? { status: 'sent', agreed, withPassword: form.passwords.length > 0 } : { status: 'no_register', reason: '点了「获取邮箱激活码」，页面上没看到发出去' }
}

export async function submitRegisterCode(page: PageLike, code: string): Promise<{ ok: boolean; reason?: string }> {
  const codeField = codeFieldOf(await extractFields(page))
  if (!codeField) return { ok: false, reason: '没找到填激活码的格子' }
  await page.fill(codeField.selector, code.trim())
  if (!(await clickText(page, REGISTER_BUTTON_RX, false, codeField.selector))) return { ok: false, reason: '没找到「注册」按钮' }
  return { ok: true }
}

const SET_PASSWORD_BUTTON_RX = '^(确定|确认|保存|提交|完成|下一步)$'

/**
 * 收码登录后网站要「首次登录 · 设置密码」（2026-11-03 中国中车：登上了，还弹一个只有密码格的框）：
 * 只在页面上只剩密码格（没有邮箱、没有验证码）时填上调用方生成的密码、点确定。填了返回 true，调用方把密码存进私密库。
 */
export async function setFirstPassword(page: PageLike, password: string): Promise<boolean> {
  const fields = await extractFields(page)
  const passwords = passwordFieldsOf(fields)
  if (!passwords.length || emailFieldOf(fields) || codeFieldOf(fields)) return false
  for (const p of passwords) await page.fill(p.selector, password)
  return !!(await clickText(page, SET_PASSWORD_BUTTON_RX, false, passwords[0].selector))
}
