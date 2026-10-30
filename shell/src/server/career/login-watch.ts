/**
 * 在一页上盯「登上了没有」（数据层）：开始时记下这个站的会话凭证，之后看有没有新凭证、登录类请求有没有返回失败。
 * 登录之旅（login-journey-host）和对话里浏览时请人登录（browse-handoff.waitForUser）共用这一份，判断只有一处。
 */
import type { Page, Response } from 'playwright';

import { siteOf } from './app-pages';
import { authCookies, loggedIn, newCredentials, responseVerdict, type ResponseVerdict } from './login-signal';

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

export interface LoginWatch { site: string | null; check(): Promise<string[]>; stop(): void }

/** 开始盯：check() 返回登上以后新出现的凭证名（空 = 还没登上）。 */
export async function watchLogin(page: Page): Promise<LoginWatch> {
  const site = siteOf(page.url());
  const read = async () => (site ? authCookies(await page.context().cookies(), site) : new Map<string, string>());
  const before = await read();
  let last: ResponseVerdict = null;
  const stop = onLoginResponse(page, v => { last = v; });
  return {
    site,
    check: async () => { const fresh = newCredentials(before, await read()); return loggedIn(fresh, last) ? fresh : []; },
    stop,
  };
}
