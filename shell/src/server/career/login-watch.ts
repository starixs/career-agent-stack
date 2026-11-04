/**
 * 在一页上盯「登上了没有」：数据层（新会话凭证、登录请求的返回）和画面（登录提示还在不在、有没有报错）两路一起看，
 * 由 login-signal.LoginJudge 合起来判断。登录之旅（login-journey-host）和对话里浏览时请人登录
 * （browse-handoff.waitForUser）共用这一份，判断只有一处。
 */
import type { Page, Response } from 'playwright';

import { siteOf } from './app-pages';
import { detectHints, inPage } from './browse';
import { hintSampleInPage } from './browse-handoff';
import { authCookies, isLoginEndpoint, LOGIN_ERROR_TEXT, LoginJudge, responseVerdict, type LoginJudgement, type ResponseVerdict, type ScreenSample } from './login-signal';

/** 登录返回体最多读多少：只为看 success / code，太大的不是登录接口。 */
const MAX_BODY = 20_000;

/**
 * 一条响应：Playwright 的有 headers / text；真实 Chrome 桥接的被动响应只有 json（2026-11-04 合入 main 后的浏览器）。
 */
export type ResponseLike = Pick<Response, 'url' | 'status'> & { headers?: () => Record<string, string>; text?: () => Promise<string>; json?: () => Promise<unknown> };

export async function responseBody(r: ResponseLike): Promise<string | null> {
  try {
    if (r.headers && r.text) {
      const type = r.headers()['content-type'] ?? '';
      if (!/json|text\/plain/i.test(type)) return null;
      const text = await r.text();
      return text.length > MAX_BODY ? null : text;
    }
    if (!r.json) return null;
    const text = JSON.stringify(await r.json());
    return text.length > MAX_BODY ? null : text;
  } catch (e) {
    // 跳转（3xx）、已被页面丢弃、不是 JSON 的响应读不到正文：只按状态码判断
    console.warn(`[career] login-watch: 读不到 ${r.url()} 的返回`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 听这一页的登录类请求返回；返回取消监听的函数。 */
export function onLoginResponse(page: Page, cb: (v: ResponseVerdict) => void): () => void {
  // 只读登录接口的返回体：桥接下读正文要单独请求一次，别的请求不碰
  const on = (r: ResponseLike) => {
    if (!isLoginEndpoint(r.url())) return;
    void responseBody(r).then(b => { const v = responseVerdict(r.url(), r.status(), b); if (v) cb(v); });
  };
  page.on('response', on);
  return () => { page.off('response', on); };
}

/** 画面这一路：页面上还有没有登录框 / 登录提示，有没有登录报错。页面在跳转、读不到时返回 null（这一次只靠数据层）。 */
export async function screenSample(page: Page): Promise<ScreenSample | null> {
  try {
    const sample = await inPage(page, hintSampleInPage, null);
    // 看得见「退出」又没有开着的登录表单：登上了，导航里剩个「登录/注册」字样不算还要登录
    const loginShown = !(sample.loggedIn && !sample.loginForm) && detectHints(sample, []).includes('login');
    return { loginShown, errorShown: LOGIN_ERROR_TEXT.test(sample.bodySample), formShown: sample.loginForm, loggedIn: sample.loggedIn };
  } catch (e) {
    console.warn(`[career] login-watch: 这次读不到画面（${page.url()}）`, e instanceof Error ? e.message : e);
    return null;
  }
}

export interface LoginWatch { site: string | null; check(): Promise<LoginJudgement>; stop(): void }

/** 开始盯：每次 check() 两路各看一次，给出合起来的判断。 */
export async function watchLogin(page: Page): Promise<LoginWatch> {
  const site = siteOf(page.url());
  // 真实 Chrome 桥接不导出 Cookie：读不到就只靠登录接口返回和画面
  const read = async () => {
    const context = page.context() as Partial<Pick<ReturnType<Page['context']>, 'cookies'>>;
    return site && typeof context.cookies === 'function' ? authCookies(await context.cookies(), site) : new Map<string, string>();
  };
  const judge = new LoginJudge(await read());
  const stop = onLoginResponse(page, v => judge.response(v));
  return { site, check: async () => judge.observe(await read(), await screenSample(page)), stop };
}
