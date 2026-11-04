import type { PageLike } from './page.js'
import { extractFields, type FormField } from './extract.js'
import { detectObstacle } from './guards.js'
import { pageSignalsScript } from './scripts.js'
import type { PageScript } from './scripts.js'
import { markByTextScript, WIDGET_SCRIPT_IDS } from './widgets.js'

/**
 * 登录页代填：把私密库里的账号 / 密码填进登录表单，**不点登录、不碰验证码**。
 * 纯确定性（label / name / placeholder 关键词匹配），不经过模型；凭证只在 Node 侧流转。
 * 登录本身仍由用户本人完成（点击登录、滑块、短信码），与产品契约"登录交给用户"一致。
 *
 * 短信码登录（2026-11-03 用户定：能用手机验证码登录的，他只管收验证码，其余都不用管）：
 * prepareSmsLogin 切到「手机号登录」、填手机号、勾登录协议、点「获取验证码」；他报验证码后 submitSmsCode 填上并点登录。
 * 点了获取验证码弹出滑块 / 拼图：如实报 captcha，交给他本人在画面上过，过完再接着等验证码。
 */
export interface LoginCredential { username?: string; password?: string }
export interface LoginFillResult { filled: Array<'username' | 'password'>; skipped: string[] }

export const PASSWORD_RX = /(密码|password|passwd|pwd)/i
export const USERNAME_RX = /(用户名|账号|帐号|账户|帐户|手机号|手机|邮箱|邮件|登录名|login|account|username|user ?name|phone|mobile|email|uid)/i
const CAPTCHA_FIELD_RX = /(验证码|captcha|verify|code)/i

export const keyOf = (f: FormField) => `${f.label} ${f.name ?? ''} ${f.placeholder ?? ''}`

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

const SMS_TAB_RX = '^(手机号?登录|验证码登录|短信登录|手机验证码登录|手机号验证码登录)$'
const SEND_CODE_RX = '^(获取验证码|发送验证码|获取短信验证码|获取动态码|发送短信|获取校验码|免费获取验证码)$'
export const LOGIN_BUTTON_RX = '^(登录|立即登录|登录/注册|注册/登录|登录注册|确定|确认登录|下一步)$'
export const AGREE_RX = '(已阅读|阅读并同意|同意|隐私|协议|条款)'
export const CODE_FIELD_RX = /(验证码|校验码|动态码|短信码|激活码|code)/i
/** 发码成功的样子：倒计时（59s / 59 秒 / 重新发送(59)）或提示语。 */
const SENT_RX = /(\d{1,2}\s*(s|S|秒)|重新(发送|获取)|已发送|发送成功|验证码已发)/
/** 点了获取验证码后最多看 6 秒：拼图常常隔一两秒才弹。 */
const SEND_CHECKS = 6
const SEND_CHECK_MS = 1000
const PHONE_FIELD_RX = /(手机|电话|phone|mobile|tel)/i

export type SmsPrepareResult =
  | { status: 'sent'; agreed: boolean }
  | { status: 'captcha'; evidence: string }
  | { status: 'no_sms'; reason: string }

export async function clickText(page: PageLike, pattern: string, checkbox = false, near?: string): Promise<string | null> {
  const hit = await page.evaluate(markByTextScript, { pattern, checkbox, ...(near ? { near } : {}) }).catch(() => ({ selector: null }))
  if (!hit.selector) return null
  await page.click(hit.selector)
  return hit.text ?? ''
}

/** 页面上弹没弹拼图 / 滑块（点获取验证码之后，或点击被一层滑块挡住时）。 */
export async function captchaOnPage(page: PageLike): Promise<string | null> {
  const ob = detectObstacle(await page.evaluate(pageSignalsScript))
  return ob && (ob.reason === 'captcha' || ob.reason === '2fa') ? ob.evidence : null
}

/** 详情页上还没打开登录框（滴滴、Moka 的岗位页）：先点页面自己的「登录」——只是打开登录框，不提交任何东西。 */
/**
 * 扫码 / 别的登法后面藏着的账号登录入口（2026-11-03 用户：发现要扫码别直接停，先找有没有账号登录，只给扫码才停）。
 * 一个站的做法是一类站的范例：这些字样各家网申都用。
 */
export const OTHER_LOGIN_RX = '^(账号登录|账户登录|密码登录|账号密码登录|邮箱登录|使用邮箱登录|其他登录方式|其他方式登录|更多登录方式|切换登录方式|使用账号登录|使用密码登录|手机号登录|手机登录)$'

export const OPEN_LOGIN_RX = '^(登录|登录/注册|注册/登录|登录注册|立即登录|去登录|请登录)$'

/**
 * 登录框只给扫码（中国中车：只有「微信扫码」和一张二维码、没有任何输入框）：点框右上角那个折角图标切到账号登录。
 * 只在「框里看得见扫码、没有可填的格子」时找；关闭按钮不算。返回点没点。
 */
export const cornerSwitchScript: PageScript<null, { selector: string | null; x?: number; y?: number }> = {
  id: WIDGET_SCRIPT_IDS.cornerSwitch,
  fn: () => {
    const CORNER_INSET = 16
    const seen = (n: Element) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
    for (const n of Array.from(document.querySelectorAll('[data-career-mark]'))) n.removeAttribute('data-career-mark')
    // 登录框 / 弹框，以及卡片大小、写着扫码的块（2026-11-03 北森登录页：卡片 class 是 STFormWraper，角标在它右上角，外面整页才叫 Login）；小的先看
    const cardLike = (n: Element) => { const r = n.getBoundingClientRect(); return r.width >= 200 && r.width <= 700 && r.height >= 200 && r.height <= 800 && /(扫码|二维码)/.test(n.textContent || '') }
    const boxes = [...new Set([...Array.from(document.querySelectorAll('[role=dialog], [class*="modal" i], [class*="login" i], [class*="dialog" i]')), ...Array.from(document.querySelectorAll('div, section, form')).filter(cardLike)])]
      .filter(seen).sort((a, b) => { const x = a.getBoundingClientRect(); const y = b.getBoundingClientRect(); return x.width * x.height - y.width * y.height })
    for (const box of boxes) {
      const text = (box.textContent || '').replace(/\s+/g, '')
      // 能打字的格子：只算点得到的（理想：扫码那面盖在手机号表单上，表单的格子也「看得见」）
      const onTop = (n: Element) => { const b = n.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && (n === e || n.contains(e) || e.contains(n)) }
      const typable = Array.from(box.querySelectorAll('input:not([type=hidden]):not([type=checkbox])')).some(n => seen(n) && onTop(n))
      if (!/(扫码|二维码)/.test(text) || typable) continue
      const r = box.getBoundingClientRect()
      const corner = Array.from(box.querySelectorAll('svg, img, i, span, div, a')).filter(n => {
        const b = n.getBoundingClientRect()
        const closeLike = !!n.closest('[aria-label*="close" i], [class*="close" i]')
        const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        // 点得到的那一个：卡片正反面叠着时，背面的角标点下去是正面挨了一下（2026-11-03 理想：把手机号登录翻成了扫码）
        const reachable = !!e && (n === e || n.contains(e))
        return seen(n) && reachable && !closeLike && getComputedStyle(n).cursor === 'pointer' && b.width <= 120 && b.height <= 120 && b.right >= r.right - 8 && b.top <= r.top + 8
      })
      const hit = corner.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
      if (hit) { hit.setAttribute('data-career-mark', '1'); return { selector: '[data-career-mark="1"]' } }
      // 角标是转了 45° 的大方块、外框伸出卡片（2026-11-03 理想：171×171 的三角）：直接看卡片右上角往里一点，那一点可点又不是关闭就点那里
      const x = r.right - CORNER_INSET, y = r.top + CORNER_INSET
      const at = document.elementFromPoint(x, y)
      const pointer = (n: Element | null) => { for (let a = n, i = 0; a && i < 3 && box.contains(a); a = a.parentElement, i++) if (getComputedStyle(a).cursor === 'pointer') return true; return false }
      if (at && box.contains(at) && pointer(at) && !at.closest('[aria-label*="close" i], [class*="close" i]')) { at.setAttribute('data-career-mark', '1'); return { selector: '[data-career-mark="1"]', x, y } }
    }
    return { selector: null }
  },
}

/** 扫码框切到账号登录；切了返回 true。短信登录、邮箱注册都先走这一步。 */
export async function switchFromQrLogin(page: PageLike): Promise<boolean> {
  const hit = await page.evaluate(cornerSwitchScript, null)
  if (!hit.selector) return false
  // 按坐标认出来的角标：点那一点（转过的元素按外框中心点会点偏）
  if (hit.x !== undefined && hit.y !== undefined && page.mouse) await page.mouse.click(hit.x, hit.y)
  else await page.click(hit.selector)
  return true
}

const phoneFieldOf = (fields: FormField[]) => fields.find(f => ['text', 'tel'].includes(f.type) && PHONE_FIELD_RX.test(keyOf(f)) && !CODE_FIELD_RX.test(keyOf(f)))
export const codeFieldOf = (fields: FormField[]) => fields.find(f => ['text', 'tel', 'number'].includes(f.type) && CODE_FIELD_RX.test(keyOf(f)) && !PHONE_FIELD_RX.test(keyOf(f)))

/**
 * 这些格子里哪些点得到（中心那一点最上层是它自己）。登录卡正反两面叠着时，背面的输入框也「看得见」（2026-11-03 理想：
 * 默认是扫码那面，手机号表单压在下面），当成到了就去填，填到超时。
 */
export const reachableScript: PageScript<string[], string[]> = {
  id: WIDGET_SCRIPT_IDS.reachable,
  fn: selectors => selectors.filter(sel => {
    const n = document.querySelector(sel)
    if (!n) return false
    const r = n.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true // 在屏幕外：滚过去再说
    const e = document.elementFromPoint(x, y)
    return !e || n === e || n.contains(e) || e.contains(n)
  }),
}

async function reachableFields(page: PageLike): Promise<FormField[]> {
  const fields = await extractFields(page)
  const ok = new Set(await page.evaluate(reachableScript, fields.map(f => f.selector)))
  return fields.filter(f => ok.has(f.selector))
}

/**
 * 打开登录框：页面上还没有登录格子时才点「登录」。登录框已经开着时「登录」是提交按钮，点了只会报一排红字
 * （2026-11-03 网易：手机号 / 验证码 / 证件号全空提交）。
 */
export async function openLogin(page: PageLike): Promise<string | null> {
  const open = (await reachableFields(page)).some(f => ['text', 'tel', 'email'].includes(f.type) && (CODE_FIELD_RX.test(keyOf(f)) || PASSWORD_RX.test(keyOf(f)) || PHONE_FIELD_RX.test(keyOf(f))))
  return open ? null : clickText(page, OPEN_LOGIN_RX)
}

/** 切登录框 / 换标签后等它渲染。 */
const STEP_WAIT_MS = 600
/** 跳到登录页后等格子渲染出来的上限和间隔。 */
const NAV_RENDER_MS = 3000
const NAV_RENDER_POLL_MS = 300

/**
 * 依次试几步点击，每步之后看一眼到没到 done；到了就停。某一步点不到（被弹框挡住、超时）记一笔接着试下一步，
 * 不让一次点不到把整件事判成「没有这种登录」。返回最后看到的格子。
 */
export async function walkUntil(page: PageLike, steps: Array<() => Promise<unknown>>, done: (fields: FormField[]) => boolean, sleep: (ms: number) => Promise<void>): Promise<FormField[]> {
  let fields = await reachableFields(page)
  let seenUrl = page.url()
  // 跳到了独立登录页（2026-11-03 网易、理想：详情页「登录」过一会儿才跳 /login）：等新页渲染出来再看，不然读到的是空白页
  const followNavigation = async () => {
    if (page.url() === seenUrl) return
    seenUrl = page.url()
    await page.waitForLoad?.()
    fields = await reachableFields(page)
    // 单页应用：网址先变、格子后到（网络早就安静了）。等到出现能打字的格子，最多 NAV_RENDER_MS
    for (let waited = 0; waited < NAV_RENDER_MS && !fields.some(f => ['text', 'tel', 'email'].includes(f.type)); waited += NAV_RENDER_POLL_MS) {
      await sleep(NAV_RENDER_POLL_MS)
      fields = await reachableFields(page)
    }
  }
  for (const [i, step] of steps.entries()) {
    await followNavigation()
    if (done(fields)) break
    let moved: unknown
    try { moved = await step() } catch (e) {
      console.warn(`[apply-login] 第 ${i + 1} 步点不到，试下一步：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
      continue
    }
    if (moved) { await sleep(STEP_WAIT_MS); fields = await reachableFields(page) }
  }
  await followNavigation()
  return fields
}

export async function prepareSmsLogin(page: PageLike, phone: string, opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<SmsPrepareResult> {
  const sleep = opts.sleep ?? (ms => page.waitForTimeout(ms))
  // 一步步往「手机号 + 验证码」走：切短信标签 → 扫码框切账号（框可能已经弹着，导航上的「登录」被它挡住，2026-11-03 中国中车）
  // → 还没有就先打开登录框再来一遍
  const steps = [
    () => clickText(page, SMS_TAB_RX), () => switchFromQrLogin(page), () => clickText(page, OTHER_LOGIN_RX), () => clickText(page, SMS_TAB_RX),
    () => openLogin(page), () => switchFromQrLogin(page), () => clickText(page, OTHER_LOGIN_RX), () => clickText(page, SMS_TAB_RX),
  ]
  const fields = await walkUntil(page, steps, f => !!phoneFieldOf(f) && !!codeFieldOf(f), sleep)
  const phoneField = phoneFieldOf(fields)
  if (!phoneField || !codeFieldOf(fields)) return { status: 'no_sms', reason: '登录页上没有「手机号 + 验证码」' }
  await page.fill(phoneField.selector, phone)
  const agreed = !!(await clickText(page, AGREE_RX, true))
  // 获取验证码被一层滑块挡着点不到（飞书招聘先出滑块）：如实报要他过一下，不当成「没有短信登录」（2026-11-03 小鹏）
  let sent: string | null
  try { sent = await clickText(page, SEND_CODE_RX, false, codeFieldOf(fields)?.selector) } catch (e) {
    const cap = await captchaOnPage(page)
    if (cap) return { status: 'captcha', evidence: cap }
    throw e
  }
  if (!sent) return { status: 'no_sms', reason: '没找到「获取验证码」' }
  const after = await confirmSent(page, sleep)
  if (after.status === 'captcha') return after
  return after.status === 'sent' ? { status: 'sent', agreed } : { status: 'no_sms', reason: '点了「获取验证码」，页面上没看到发出去（没有倒计时、没有发送成功）' }
}

/**
 * 发出去没有要看页面说了算：倒计时 / 「发送成功」才算发了；拼图常常隔一两秒才弹出来（2026-11-03 报了已发码、手机上却没收到）。
 * 短信码、邮箱激活码共用。
 */
export async function confirmSent(page: PageLike, sleep: (ms: number) => Promise<void>): Promise<{ status: 'sent' } | { status: 'captcha'; evidence: string } | { status: 'unseen' }> {
  for (let i = 0; i < SEND_CHECKS; i++) {
    await sleep(SEND_CHECK_MS)
    const cap = await captchaOnPage(page)
    if (cap) return { status: 'captcha', evidence: cap }
    const sig = await page.evaluate(pageSignalsScript)
    if (SENT_RX.test(`${sig.text} ${sig.buttons.map(b => b.text).join(' ')}`)) return { status: 'sent' }
  }
  return { status: 'unseen' }
}

export async function submitSmsCode(page: PageLike, code: string): Promise<{ ok: boolean; reason?: string }> {
  const codeField = codeFieldOf(await extractFields(page))
  if (!codeField) return { ok: false, reason: '没找到填验证码的格子' }
  await page.fill(codeField.selector, code.trim())
  if (!(await clickText(page, LOGIN_BUTTON_RX, false, codeField.selector))) return { ok: false, reason: '没找到「登录」按钮' }
  return { ok: true }
}
