import type { PageLike } from './page.js'
import { findImageCode } from './image-code.js'
import { AGREE_RX, captchaOnPage, clickText, LOGIN_BUTTON_RX, openLogin, OTHER_LOGIN_RX, pickLoginFields, switchFromQrLogin, walkUntil } from './login.js'

/**
 * 存过的账号密码登录（2026-11-03 用户：「支持账号密码登录的话，这个肯定是最方便的，只用记录一次，存进去，后面都不用管」）：
 * 往「账号 + 密码」那个表单走（扫码框切账号、「密码登录」标签…），填上、勾协议、点登录。
 * 密码登录也弹图形码（中国中车）：报 image_code，他看图打的字由 submitPasswordLogin 填回去再点登录。
 */
const PASSWORD_TAB_RX = '^(密码登录|账号密码登录|账号登录|账户登录|使用密码登录)$'
/** 填完账号密码后等图形码 / 协议框出来。 */
const SETTLE_MS = 600

export type PasswordLoginResult =
  | { status: 'submitted' }
  | { status: 'image_code' }
  | { status: 'captcha'; evidence: string }
  | { status: 'no_form'; reason: string }

async function clickLogin(page: PageLike, near: string): Promise<PasswordLoginResult> {
  try {
    return (await clickText(page, LOGIN_BUTTON_RX, false, near)) ? { status: 'submitted' } : { status: 'no_form', reason: '没找到「登录」按钮' }
  } catch (e) {
    const cap = await captchaOnPage(page)
    if (cap) return { status: 'captcha', evidence: cap }
    throw e
  }
}

export async function preparePasswordLogin(page: PageLike, cred: { username: string; password: string }, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<PasswordLoginResult> {
  const sleep = opts.sleep ?? (ms => page.waitForTimeout(ms))
  const steps = [
    () => clickText(page, PASSWORD_TAB_RX), () => switchFromQrLogin(page), () => clickText(page, OTHER_LOGIN_RX), () => clickText(page, PASSWORD_TAB_RX),
    () => openLogin(page), () => switchFromQrLogin(page), () => clickText(page, OTHER_LOGIN_RX), () => clickText(page, PASSWORD_TAB_RX),
  ]
  const fields = await walkUntil(page, steps, f => { const l = pickLoginFields(f); return !!l.username && !!l.password }, sleep)
  const { username, password } = pickLoginFields(fields)
  if (!username || !password) return { status: 'no_form', reason: '没找到「账号 + 密码」的登录表单' }
  await page.fill(username.selector, cred.username)
  await page.fill(password.selector, cred.password)
  await clickText(page, AGREE_RX, true)
  await sleep(SETTLE_MS)
  if (await findImageCode(page)) return { status: 'image_code' }
  return clickLogin(page, password.selector)
}

/** 他看图打的字填进图形码格子，再点登录。 */
export async function submitPasswordLogin(page: PageLike, imageText: string): Promise<PasswordLoginResult> {
  const target = await findImageCode(page)
  if (!target) return { status: 'no_form', reason: '图形码格子不见了' }
  await page.fill(target.input, imageText.trim())
  return clickLogin(page, target.input)
}
