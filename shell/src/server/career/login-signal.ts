/**
 * 登录成功没有：数据层和画面两路一起看（用户 2026-10-30：要看数据层，不止看画面；画面也是很重要的一方面）。
 *
 *  - 数据层：这个网站发下了新的 / 换掉了会话凭证 Cookie；登录类请求的返回。
 *  - 画面：登录框 / 「扫码登录」这类提示连续两次都不在了；页面上出现「密码错误」「验证码错误」这类字。
 *  - 合起来（LoginJudge）：任何一路说失败（接口返回失败、画面报错）就继续等；否则数据层有新凭证、或画面上登录提示
 *    稳定消失，任一成立就算登上。登录表单（手机号 / 验证码 / 密码框）还开着时，新凭证要配上登录接口返回成功才算
 *    （2026-11-02 美团：点「获取验证码」弹滑块、发了几个带 token 的 Cookie，没登就被放行）。凭证名起得偏、数据层认不出的站，靠画面也能过；画面一直留着登录字样的站，靠数据层过。
 *
 *  细节：凭证按站（含同公司的单点登录域名，按 siteOf 归到同一站）算；登录类请求（地址带 login / auth / passport / sso …）
 *  返回 4xx、success:false、非 0 业务码算失败——密码错时有的站也会刷新会话 Cookie，所以失败要能否决。
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
/** 发验证码、过滑块这类请求：成功只说明码发出去了 / 滑块过了，不是登上了（美团 yoda 滑块）。 */
const NOT_LOGIN_RESULT_URL = /(send_?(sms|code)|sms|get_?code|verify_?code\/send|captcha|slider|yoda)/i;

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
/** 这个网址像不像登录接口（只有像的才值得读返回体）。 */
export function isLoginEndpoint(url: string): boolean { return LOGIN_URL.test(url) && !NOT_LOGIN_RESULT_URL.test(url); }

export function responseVerdict(url: string, status: number, body: string | null): ResponseVerdict {
  if (!isLoginEndpoint(url)) return null;
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

/** 画面上看到的：还有没有登录框 / 登录提示，有没有登录报错；formShown = 登录表单（手机号 / 验证码 / 密码输入框）还开着。 */
export interface ScreenSample { loginShown: boolean; errorShown: boolean; formShown?: boolean; /** 看得见「退出」这类登上后才有的入口 */ loggedIn?: boolean }
/** 画面上的登录报错。 */
export const LOGIN_ERROR_TEXT = /(密码错误|密码不正确|验证码错误|验证码不正确|账号或密码|用户名或密码|登录失败|账号不存在)/;
/** 登录提示连续这么多次不在才算消失（登录跳转途中会闪一下）。 */
const SCREEN_CLEAR_STREAK = 2;

export type LoginSignal = 'credentials' | 'screen' | 'both';
export interface LoginJudgement { state: 'logged_in' | 'failed' | 'waiting'; signal?: LoginSignal; credentials: string[] }

/** 两路合起来判断：一次登录过程一个实例，开始时给登录前的凭证。 */
export class LoginJudge {
  private last: ResponseVerdict = null;
  /** 失败那一刻的凭证（指纹）：之后凭证又变了，说明用户重试登上了，失败不再否决。 */
  private failedAt: string | null = null;
  private streak = 0;
  /** 画面这一路只认「登录框出现过、然后不见了」：一开始就没有登录框的页（岗位详情页、导航栏里一个登录链接）
   *  不能因为「看不到登录框」就判登上（2026-10-31 实例测试：3 家 1.5 秒内全被判登上，用户根本没登）。 */
  private loginSeen = false;
  constructor(private readonly before: ReadonlyMap<string, string>) {}
  /** 听到一个登录类请求的返回。 */
  response(v: ResponseVerdict): void { if (v) { this.last = v; if (v === 'ok') this.failedAt = null; } }
  /** 看一次：此刻的凭证 + 画面（拿不到画面时给 null，只靠数据层）。 */
  observe(after: ReadonlyMap<string, string>, screen: ScreenSample | null): LoginJudgement {
    const fresh = newCredentials(this.before, after);
    const print = [...after].map(([k, v]) => `${k}=${v}`).sort().join(';');
    if (this.last === 'fail' && this.failedAt === null) this.failedAt = print;
    if (this.last === 'fail' && this.failedAt !== print) { this.last = null; this.failedAt = null; }
    if (screen?.loginShown) this.loginSeen = true;
    this.streak = this.loginSeen && screen && !screen.loginShown && !screen.errorShown ? this.streak + 1 : 0;
    if (this.last === 'fail' || screen?.errorShown) return { state: 'failed', credentials: fresh };
    // 登录表单还开着时，新冒出来的 Cookie 只是访客 / 风控凭证（美团点「获取验证码」就发了一批），要有登录接口返回成功才算
    const data = fresh.length > 0 && (!screen?.formShown || this.last === 'ok');
    // 画面上直接看得到登上了（「退出」在、登录表单不在）：不用等登录框出现再消失
    const seen = this.streak >= SCREEN_CLEAR_STREAK || (!!screen?.loggedIn && !screen.formShown && !screen.loginShown);
    if (!data && !seen) return { state: 'waiting', credentials: fresh };
    return { state: 'logged_in', signal: data && seen ? 'both' : data ? 'credentials' : 'screen', credentials: fresh };
  }
}

// ---------- 按站点学 ----------

const marksKey = (site: string) => `browser:login_marks:${site}`;

export function learnLoginMarks(repos: Repos, site: string, names: readonly string[]): void {
  if (!names.length) return;
  const prev = repos.kvGet<string[]>(marksKey(site)) ?? [];
  repos.kvSet(marksKey(site), [...new Set([...prev, ...names])]);
}

/** 学错了（页面明明还要登录）：忘掉这个站的凭证名，下次重新学。 */
export function forgetLoginMarks(repos: Repos, site: string): void {
  repos.kvSet(marksKey(site), []);
}

/** 学过这个站的凭证名，而且现在都还在、没过期：已登录。没学过返回 false（不猜）。 */
export function knownLoggedIn(repos: Repos, cookies: readonly CookieLike[], site: string, nowSec = Date.now() / 1000): boolean {
  const marks = repos.kvGet<string[]>(marksKey(site)) ?? [];
  if (!marks.length) return false;
  const live = cookies.filter(c => cookieSite(c.domain) === site && c.value && (c.expires === undefined || c.expires < 0 || c.expires > nowSec));
  return marks.every(m => live.some(c => c.name === m));
}
