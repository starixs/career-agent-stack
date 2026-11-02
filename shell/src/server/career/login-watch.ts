/**
 * 在一页上盯「登上了没有」：数据层（新会话凭证、登录请求的返回）和画面（登录提示还在不在、有没有报错）两路一起看，
 * 由 login-signal.LoginJudge 合起来判断。登录之旅（login-journey-host）和对话里浏览时请人登录
 * （browse-handoff.waitForUser）共用这一份，判断只有一处。
 */
import type { Page, Response } from 'playwright';

import { siteOf } from './app-pages';
import { detectHints, inPage } from './browse';
import { hintSampleInPage } from './browse-handoff';
import { authCookies, LOGIN_ERROR_TEXT, LoginJudge, responseVerdict, type LoginJudgement, type ResponseVerdict, type ScreenSample } from './login-signal';

/** 登录返回体最多读多少：只为看 success / code，太大的不是登录接口。 */
const MAX_BODY = 20_000;

export async function responseBody(r: Response): Promise<string | null> {
  const type = r.headers()['content-type'] ?? '';
  if (!/json|text\/plain/i.test(type)) return null;
  try { const text = await r.text(); return text.length > MAX_BODY ? null : text; } catch (e) {
    // 跳转（3xx）和已被页面丢弃的响应读不到正文：只按状态码判断
    console.warn(`[career] login-watch: 读不到 ${r.url()} 的返回`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 听这一页的登录类请求返回；返回取消监听的函数。 */
export function onLoginResponse(page: Page, cb: (v: ResponseVerdict) => void): () => void {
  const on = (r: Response) => { void responseBody(r).then(b => { const v = responseVerdict(r.url(), r.status(), b); if (v) cb(v); }); };
  page.on('response', on);
  return () => { page.off('response', on); };
}

/** 画面这一路：页面上还有没有登录框 / 登录提示，有没有登录报错。页面在跳转、读不到时返回 null（这一次只靠数据层）。 */
export async function screenSample(page: Page): Promise<ScreenSample | null> {
  try {
    const sample = await inPage(page, hintSampleInPage, null);
    return { loginShown: detectHints(sample, []).includes('login'), errorShown: LOGIN_ERROR_TEXT.test(sample.bodySample), formShown: sample.loginForm };
  } catch (e) {
    console.warn(`[career] login-watch: 这次读不到画面（${page.url()}）`, e instanceof Error ? e.message : e);
    return null;
  }
}

export interface LoginWatch { site: string | null; check(): Promise<LoginJudgement>; stop(): void }

/** 开始盯：每次 check() 两路各看一次，给出合起来的判断。 */
export async function watchLogin(page: Page): Promise<LoginWatch> {
  const site = siteOf(page.url());
  const read = async () => (site ? authCookies(await page.context().cookies(), site) : new Map<string, string>());
  const judge = new LoginJudge(await read());
  const stop = onLoginResponse(page, v => judge.response(v));
  return { site, check: async () => judge.observe(await read(), await screenSample(page)), stop };
}
