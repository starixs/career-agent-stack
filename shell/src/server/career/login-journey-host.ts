/**
 * 登录之旅接到真实托管浏览器（Global 侧车）：Cookie 从浏览器上下文读，登录类请求的返回从那一页的网络响应听，画面从那一页读，
 * 画面切换走宿主的 focusPage。整趟持有一个会话租约，免得中途上下文被回收。
 */
import type { Repos } from '@career/core';
import type { BrowserContext, Page } from 'playwright';

import { findApplicationPage, pageForApplication } from './app-pages';
import { loadApplyModule } from '../routes/career-browser';
import { careerBrowserHost, careerWorkspacePath } from './batch-service';
import { rememberSessionCookies } from './session-cookies';
import { journeyRunning, startJourney, type JourneyBrowser, type JourneyPage, type SmsState } from './login-journey';
import { openLoginCodeSource, openPhoneCodeSource } from './login-code-source';
import { loginWithSavedPassword } from './login-password';
import { answerPendingImage, autoRegisterByEmail, refreshPendingImage } from './login-register';
import { onLoginResponse, screenSample } from './login-watch';
import { logSlowCalls } from './slow-calls';

/** 本人手机号（私密库，只在 Node 侧解开，写访问日志）；没存就不代办短信登录。 */
async function ownPhone(): Promise<string | null> {
  const { getVault } = await import('./vault');
  const phone = (await getVault()).profileBasics({ actor: 'login_fill', purpose: '手机验证码登录' }).phone;
  return phone && /^\d{11}$/.test(phone.replace(/\D/g, '')) ? phone.replace(/\D/g, '') : null;
}

async function smsFirst(page: Page): Promise<SmsState> {
  const phone = await ownPhone();
  if (!phone) return { status: 'no_sms', detail: '资料里没有手机号' };
  const apply = await loadApplyModule();
  if (!apply?.prepareSmsLogin) return { status: 'no_sms', detail: '投递引擎版本不支持代办短信登录' };
  try {
    const r = await apply.prepareSmsLogin(logSlowCalls(apply.fromPlaywright(page), 'sms'), phone);
    return r.status === 'sent' ? { status: 'sent' } : { status: r.status, detail: r.status === 'captcha' ? r.evidence : r.reason };
  } catch (e) {
    // 短信这条路出错（点不到、页面跳走）不等于这家登不了：照样往下试邮箱注册
    console.warn(`[career] login-journey sms prepare FAILED ${page.url()}`, e instanceof Error ? e.message.split('\n')[0] : e);
    return { status: 'no_sms', detail: '短信登录没办成' };
  }
}

/** 手机上读码最多等多久（和 main 的短信来源一致）。 */
const PHONE_CODE_TIMEOUT_MS = 120_000;

/**
 * 短信登录：发码前就开始盯手机——配了模板按模板（精确签名），没配就用产品里连好的手机读「发码之后到的那一条」；
 * 读到码自动填上点登录，他不用动手。手机没连上或没读到，照旧请他在那一格填（2026-11-04/05 用户：手机号、邮箱都要全流程自动）。
 */
async function smsWithPhone(repos: Repos, page: Page, report: (s: SmsState) => void): Promise<SmsState> {
  const phone = await ownPhone();
  const source = phone ? (await openLoginCodeSource(repos, page.url(), 'sms', phone)) ?? (await openPhoneCodeSource()) : null;
  try {
    const since = Date.now();
    const sms = await smsFirst(page);
    if (sms.status !== 'sent' || !source) return sms;
    report({ status: 'registering', detail: '验证码发到你手机上了，我从手机上读，你不用填' });
    const code = await source.wait(since, PHONE_CODE_TIMEOUT_MS);
    if (!code) return { status: 'sent', detail: '手机上没读到验证码，收到了填这里' };
    report({ status: 'registering', detail: '从手机上读到验证码了，正在登录' });
    const apply = await loadApplyModule();
    const done = apply?.submitSmsCode ? await apply.submitSmsCode(apply.fromPlaywright(page), code) : { ok: false, reason: '投递引擎版本不支持代办短信登录' };
    return done.ok ? { status: 'registered', detail: '短信码填好了，正在确认登上没有…' } : { status: 'sent', detail: `没填上：${done.reason ?? '再试一次'}，收到的码可以填这里` };
  } finally { await source?.close(); }
}

function journeyPage(repos: Repos, page: Page): JourneyPage {
  return {
    url: () => page.url(), onLoginResponse: cb => onLoginResponse(page, cb), screen: () => screenSample(page), closed: () => page.isClosed(),
    // 先用邮箱（码从他连着的邮箱自己取，全程不用人）；没有邮箱这条路再用手机短信（要他收码）；
    // 两条都没有，多半只能扫码——如实说（2026-11-03 用户：能用邮箱账号固定登录的就不用手机验证码）
    // 顺序（2026-11-03 用户定）：存过账号密码的直接登（记一次以后都不用管）→ 邮箱收码登录 / 注册（注册时设好密码存下）→ 手机短信
    smsPrepare: async report => {
      const byPassword = await loginWithSavedPassword(page, report);
      if (byPassword) return byPassword;
      const byMail = await autoRegisterByEmail(repos, page, report);
      if (byMail) return byMail;
      const sms = await smsWithPhone(repos, page, report);
      if (sms.status === 'no_sms') console.log(`[career] login-journey ${page.url().slice(0, 80)}: 短信这条路没走通（${sms.detail ?? '-'}）`);
      return sms.status === 'no_sms' ? { status: 'no_sms', detail: '没找到邮箱或手机号能登的方式，多半只能扫码' } : sms;
    },
    imageRefresh: () => refreshPendingImage(page),
    smsSubmit: async code => {
      if (answerPendingImage(page, code)) return { ok: true }; // 他看图打的字：交给正在等的那一步
      const apply = await loadApplyModule();
      return apply?.submitSmsCode ? apply.submitSmsCode(apply.fromPlaywright(page), code) : { ok: false, reason: '投递引擎版本不支持代办短信登录' };
    },
  };
}

/** 登录之旅直接打开一家网址：网申站首屏偶尔慢，等到 DOM 出来即可，再久就交给后台重开。 */
const OPEN_PAGE_TIMEOUT_MS = 30_000;
/** 打开后等页面请求停下来的上限：长连接 / 埋点轮询的站永远不 idle，等这么久就够渲染出登录入口了。 */
const OPEN_PAGE_SETTLE_MS = 8_000;

function browserOf(repos: Repos, context: BrowserContext, host: Awaited<ReturnType<typeof careerBrowserHost>>['host'], id: string): JourneyBrowser {
  const pages = new WeakMap<JourneyPage, Page>();
  return {
    // 真实 Chrome 桥接不导出 Cookie（main 的设计）：数据层这一路就只剩登录接口返回，画面那一路照常
    cookies: async () => (typeof context.cookies === 'function' ? context.cookies() : []),
    pageFor: appKey => {
      const page = findApplicationPage(context, id, appKey);
      if (!page) return undefined;
      const jp = journeyPage(repos, page);
      pages.set(jp, page);
      return jp;
    },
    openPage: async (appKey, url) => {
      const page = await pageForApplication(context, id, appKey, 'start');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: OPEN_PAGE_TIMEOUT_MS });
      // 网申站多是单页应用：DOM 出来时导航上的「登录」还没渲染（2026-11-03 北森：0.3 秒就判成只能扫码）。等请求停下来，等不到也照样往下走
      await page.waitForLoadState('networkidle', { timeout: OPEN_PAGE_SETTLE_MS }).catch((e: unknown) => console.log(`[career] login-journey: ${url} ${OPEN_PAGE_SETTLE_MS / 1000}s 内没安静下来，照样找登录框`, e instanceof Error ? e.message.split('\n')[0] : e));
      const jp = journeyPage(repos, page);
      pages.set(jp, page);
      return jp;
    },
    focus: jp => { const page = pages.get(jp); if (page) host.focusPage(id, page); },
    // 桥接用持久的产品浏览器资料，登录自己会留下；只有能导出 Cookie 的托管浏览器才需要记
    rememberLogin: async site => { if (typeof context.cookies === 'function') await rememberSessionCookies(context, site); },
    control: () => host.getControl(id).control,
    releaseControl: () => { host.setControl(id, 'agent'); },
  };
}

/** 开始一趟（后台跑，不等它走完）。已经在走了返回 false。 */
export async function beginLoginJourney(repos: Repos, askId: string, handoffIds: readonly string[], changed: (tables: string[]) => void): Promise<boolean> {
  if (journeyRunning()) return false;
  const { host, productSessionId: id } = await careerBrowserHost();
  void host.withProductSession(id, async context => {
    await startJourney({ repos, browser: browserOf(repos, context, host, id), sessionKey: id, changed }, askId, handoffIds);
  }, { allowHumanControl: true, create: { workspacePath: careerWorkspacePath() } }).then(
    () => console.log(`[career] login-journey ${askId} 结束`),
    (e: unknown) => console.error(`[career] login-journey FAILED ${askId}`, e instanceof Error ? e.message : e),
  );
  return true;
}
