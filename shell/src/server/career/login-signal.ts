/**
 * 登录成功没有，从数据层看（用户 2026-10-30：不要看登录框消失这种画面表象，托管浏览器拿得到网络和 Cookie）。
 *
 *  - 主信号：这个网站（含同公司的单点登录域名，按 siteOf 归到同一站）发下了新的、或换掉了原有的会话凭证 Cookie。
 *    登录成功一定会写凭证；只要出现新凭证就算登上了。
 *  - 佐证：这一页发出的登录类请求（地址带 login / auth / passport / sso …）的返回。返回明确失败（4xx、success:false、
 *    非 0 的业务码）时，即使凭证变了也不算，继续等——密码错、验证码错时有的站也会刷新会话 Cookie。
 *  - 学习：登上以后记下这个站的凭证名（kv `browser:login_marks:<站>`）。下次切到这个站之前先查这些凭证还在、
 *    没过期，就直接算已登录，不让人再看一眼。
 * 都是纯函数 + kv，浏览器对象由调用方给（login-journey.ts），这里不碰 Playwright。
 */
import type { Repos } from '@career/core';

import { siteOf } from './app-pages';

export interface CookieLike { name: string; value: string; domain: string; expires?: number }

/** 凭证类 Cookie 的名字特征。 */
const AUTH_NAME = /(token|session|sess|sid|ticket|auth|passport|jwt|login|uid|user)/i;
/** 统计 / 埋点类：名字里也常带 sid、uid，但和登录无关。 */
const TRACKING_NAME = /^(_ga|_gid|_gat|hm_|hmaccount|um_|cna|_fbp|_bl_uid|sajssdk|sensorsdata|__utm|_clck|_clsk|tfstk|isg|xlly_s)/i;
/** 登录类请求的地址特征。 */
const LOGIN_URL = /(login|signin|sign_in|auth|passport|sso|oauth|token|verify|captcha\/check)/i;

const cookieSite = (domain: string) => siteOf(`https://${domain.replace(/^\./, '')}/`);

/** 这个站的凭证类 Cookie：名字 → 值。 */
export function authCookies(cookies: readonly CookieLike[], site: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of cookies) {
    if (cookieSite(c.domain) !== site || TRACKING_NAME.test(c.name) || !AUTH_NAME.test(c.name) || !c.value) continue;
    out.set(`${c.domain}|${c.name}`, c.value);
  }
  return out;
}

/** 和登录前比，新出现或换了值的凭证（返回 Cookie 名）。空 = 还没登上。 */
export function newCredentials(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  return [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k.split('|')[1]);
}

export type ResponseVerdict = 'ok' | 'fail' | null;

/** 一个登录类请求的返回说明了什么。不是登录类请求、或看不出来，返回 null。 */
export function responseVerdict(url: string, status: number, body: string | null): ResponseVerdict {
  if (!LOGIN_URL.test(url)) return null;
  if (status >= 400) return 'fail';
  if (!body) return null;
  let json: unknown;
  try { json = JSON.parse(body); } catch { return null; } // 不是 JSON（页面 / 图片）：不当证据
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (o.success === false || o.ok === false || o.result === false) return 'fail';
  if (o.success === true || o.ok === true) return 'ok';
  const code = o.code ?? o.errcode ?? o.status_code ?? o.errorCode;
  if (typeof code === 'number' || typeof code === 'string') return ['0', '200', 'success', 'ok'].includes(String(code).toLowerCase()) ? 'ok' : 'fail';
  return null;
}

/** 合起来：有新凭证、而且最近一次登录类返回不是失败，就算登上了。 */
export function loggedIn(fresh: readonly string[], lastResponse: ResponseVerdict): boolean {
  return fresh.length > 0 && lastResponse !== 'fail';
}

// ---------- 按站点学 ----------

const marksKey = (site: string) => `browser:login_marks:${site}`;

export function learnLoginMarks(repos: Repos, site: string, names: readonly string[]): void {
  if (!names.length) return;
  const prev = repos.kvGet<string[]>(marksKey(site)) ?? [];
  repos.kvSet(marksKey(site), [...new Set([...prev, ...names])]);
}

/** 学过这个站的凭证名，而且现在都还在、没过期：已登录。没学过返回 false（不猜）。 */
export function knownLoggedIn(repos: Repos, cookies: readonly CookieLike[], site: string, nowSec = Date.now() / 1000): boolean {
  const marks = repos.kvGet<string[]>(marksKey(site)) ?? [];
  if (!marks.length) return false;
  const live = cookies.filter(c => cookieSite(c.domain) === site && c.value && (c.expires === undefined || c.expires < 0 || c.expires > nowSec));
  return marks.every(m => live.some(c => c.name === m));
}
