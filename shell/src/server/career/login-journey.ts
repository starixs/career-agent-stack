/**
 * 登录之旅（规范 §5.2「两个网站要登录，一次登录之旅算一件」；用户 2026-10-30 定）：
 * 等你条里「N 个网站要你登录」点「去登录」→ 现场画面一家一家带你过。
 *
 *  1. 切到一家之前，先看这个站学过的登录凭证还在不在（login-signal.knownLoggedIn），在就直接放行这家，不让你看；
 *  2. 否则把画面和你的操作钉在这一家（live-pin），记下这个站此刻的凭证；
 *  3. 等：数据层（新的会话凭证、登录请求的返回）和画面（登录提示还在不在、有没有报错）两路一起看（LoginJudge）——
 *     任一路说失败就继续等，任一路说登上了就算登上；或者你点了「交还」；
 *  4. 登上了：关掉这家的接管、记下凭证名、交给后台从原页接着填，切下一家；
 *  5. 一家等太久（默认 3 分钟）或你点「晚点」：停在这里，剩下的留在等你条里。
 * 后台其余几家照样并行填（不抢画面）。浏览器对象由 JourneyBrowser 给，便于测试。
 */
import type { Handoff, Repos } from '@career/core';

import { siteOf } from './app-pages';
import { BatchRunner } from './batch-runner';
import { liveHub } from './live-hub';
import { setLivePin } from './live-pin';
import { authCookies, forgetLoginMarks, knownLoggedIn, learnLoginMarks, LoginJudge, type CookieLike, type LoginSignal, type ResponseVerdict, type ScreenSample } from './login-signal';

export interface JourneyPage {
  url(): string; onLoginResponse(cb: (verdict: ResponseVerdict) => void): () => void; /** 画面这一路；读不到给 null */ screen(): Promise<ScreenSample | null>;
  /** 替他填号、勾协议、点获取验证码；没有就不代办。 */
  smsPrepare?(report: (state: SmsState) => void, signal?: AbortSignal): Promise<SmsState>;
  /** 他报上来的验证码：填上并点登录。 */
  smsSubmit?(code: string): Promise<{ ok: boolean; reason?: string }>;
  /** 图形码看不清：在网站上换一张，返回新图（取不到图返回 null）。 */
  imageRefresh?(): Promise<string | null>;
  /** 页面被关掉了（学生关了窗口 / 标签）。 */
  closed(): boolean;
}
export interface JourneyBrowser {
  cookies(): Promise<CookieLike[]>;
  pageFor(appKey: string): JourneyPage | undefined;
  /** 页面没了（App 重启过 / 被关掉）：直接打开这家的网址，在这一家登录（2026-11-03）。 */
  openPage?(appKey: string, url: string): Promise<JourneyPage | undefined>;
  /** 把画面切到这一页（强制）。 */
  focus(page: JourneyPage): void;
  /** 用户此刻是否在接管。 */
  control(): 'agent' | 'human';
  /** 收尾：控制权还给助理。 */
  releaseControl(): void;
  /** 登上了：记下这个站的会话 Cookie，重启后补回（session-cookies.ts）。 */
  rememberLogin?(site: string): Promise<void>;
}
export interface JourneyDeps {
  repos: Repos; browser: JourneyBrowser; sessionKey: string;
  changed: (tables: string[]) => void;
  pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}
export type StepOutcome = 'known' | 'logged_in' | 'handed_back' | 'timeout' | 'cancelled' | 'skipped' | 'no_page' | 'page_closed';
export interface JourneyResult { steps: Array<{ handoff_id: string; outcome: StepOutcome; credentials?: string[]; signal?: LoginSignal }> }

/** 一家最多等多久：扫码 + 手机确认、等短信码，三分钟够了；再长就停下，剩下的留在等你条里。 */
export const JOURNEY_STEP_TIMEOUT_MS = 180_000;
const POLL_MS = 1500;

let cancelled = false;
let running: Promise<JourneyResult> | null = null;
export const journeyRunning = () => running !== null;
export function cancelJourney(): void { cancelled = true; }
/**
 * 「这家先跳过」：这一家登不了（只能 QQ / 微信登录、手边没有账号），不让它卡住后面几家（2026-11-02 腾讯校招）。
 * 这家的接管留着，回头还在等你里；登录之旅接着下一家。
 */
let skipRequested = false;
export function skipJourneyStep(): void { skipRequested = true; }

/**
 * 手机验证码登录（2026-11-03 用户定：能用短信码登的，他只管收验证码）：切到这一家时先替他填号、勾协议、点获取验证码，
 * 他把收到的码报上来（现场窗里那一格）就替他填上点登录。点了获取验证码弹拼图：那一步还得他本人在画面上过。
 */
/**
 * registering：没有短信登录、用他连着的邮箱登录 / 注册，正在等验证码信；registered：办完了，等网站登上；
 * image_code：网站弹了图形码，要他看图打字（image 是那张图），打的字照样从短信码那一格报上来。
 * mail_captcha：走邮箱那条路时网站弹了拼图，他在画面上拖好，码发到邮箱由我们自己取，不用他填（2026-11-03 畅游）。
 */
export type SmsState = {
  status: 'sent' | 'captcha' | 'mail_captcha' | 'no_sms' | 'registering' | 'registered' | 'image_code' | 'checking' | 'logged_in';
  detail?: string; image?: string;
  /** 这是哪一家（他填的码对应哪个网站，2026-11-03 用户：「我也不知道你对应的是哪一个」） */
  site?: string;
};
/**
 * 反馈（2026-11-03 用户：填完不知道生没生效、对应哪一家，「好像弄了白弄」）：他报上码 → checking「已填进 X，正在确认」；
 * 短信码过一会儿还没登上 → 回到 sent 并说没登上；登上了 → logged_in「X 已登录」，留一会儿让他看到。
 */
let sms: { page: JourneyPage; state: SmsState; checkingAt?: number } | null = null;
let smsSite: string | undefined;
let smsChanged: ((tables: string[]) => void) | null = null;
/**
 * 登录之旅的状态变了（换了一家、发了码、要看图、登上了）：告诉现场画面重新拉一次快照。
 * 不然画面在旅程开始前就开着时，验证码那一格永远不出来（2026-11-03 他在中车「没看到可以填验证码的地方」）。
 */
export const JOURNEY_EVENT = 'career:journey';
function journeyChanged(): void { liveHub.publish(JOURNEY_EVENT); }
/** 短信码填上后多久还没登上，就告诉他这个码没登上。 */
const CHECK_GRACE_MS = 20_000;
/** 「X 已登录」留多久。 */
const DONE_SHOW_MS = 8_000;
export function journeySms(): SmsState | null { return sms?.state ?? null; }
/** 跳过 / 取消后被丢下的那一页：它的准备工作还在后台跑完，跑完报上来的状态不能冲掉下一家的那一格。 */
const abandoned = new WeakSet<JourneyPage>();
function setSms(page: JourneyPage, state: SmsState, extra: { checkingAt?: number } = {}): void {
  if (abandoned.has(page)) return;
  sms = { page, state: { ...state, ...(smsSite ? { site: smsSite } : {}) }, ...extra };
  smsChanged?.(['handoff']);
  journeyChanged();
}
export async function submitJourneyCode(code: string): Promise<{ ok: boolean; reason?: string }> {
  const cur = sms;
  const waiting = cur && ['sent', 'captcha', 'image_code'].includes(cur.state.status);
  if (!cur?.page.smsSubmit || !waiting) return { ok: false, reason: '现在没有在等验证码的网站' };
  const before = cur.state;
  setSms(cur.page, { status: 'checking', detail: before.status === 'image_code' ? 'image' : 'sms' }, { checkingAt: Date.now() });
  const r = await cur.page.smsSubmit(code);
  if (!r.ok) setSms(cur.page, { ...before, detail: `没填上：${r.reason ?? '再试一次'}` });
  return r;
}
/** 他点了图形码那张图：网站上换一张，产品里跟着换（2026-11-03 CAS-7：和在浏览器里点图一样）。 */
export async function refreshJourneyImage(): Promise<{ ok: boolean; reason?: string }> {
  const cur = sms;
  if (!cur?.page.imageRefresh || cur.state.status !== 'image_code') return { ok: false, reason: '现在没有在等图形码的网站' };
  const image = await cur.page.imageRefresh();
  if (sms !== cur) return { ok: true }; // 换图期间这一家已经往下走了
  setSms(cur.page, { status: 'image_code', ...(image ? { image } : cur.state.image ? { image: cur.state.image } : {}), ...(image ? {} : { detail: '图没换成，看不清可以在画面上点那张图' }) });
  return { ok: true };
}
/** 短信码填上一阵还没登上：如实告诉他，可以再填一次。 */
function checkStale(now: number): void {
  if (sms?.state.status === 'checking' && sms.state.detail === 'sms' && sms.checkingAt && now - sms.checkingAt > CHECK_GRACE_MS) {
    setSms(sms.page, { status: 'sent', detail: '这个码没登上，看看画面上网站怎么说，或者等新码再填一次' });
  }
}
function showDone(page: JourneyPage): void {
  setSms(page, { status: 'logged_in' });
  const shown = sms;
  setTimeout(() => { if (sms === shown) { sms = null; smsChanged?.(['handoff']); journeyChanged(); } }, DONE_SHOW_MS);
}
async function prepareSms(deps: JourneyDeps, page: JourneyPage, signal: AbortSignal): Promise<void> {
  if (!page.smsPrepare) return;
  try {
    const report = (state: SmsState) => setSms(page, state);
    const state = await page.smsPrepare(report, signal);
    setSms(page, state);
    console.log(`[career] login-journey sms ${state.status}${state.detail ? ` (${state.detail})` : ''}`);
  } catch (e) {
    setSms(page, { status: 'no_sms', detail: e instanceof Error ? e.message : String(e) });
    console.warn('[career] login-journey sms prepare FAILED', e instanceof Error ? e.message : e);
  }
  deps.changed(['handoff']);
}

/**
 * 准备阶段（等他看图打字、等拼图后的邮件）最长要等几分钟：期间点「这家先跳过」/ 取消也要马上生效
 * （2026-11-05：邮箱那条路弹拼图时点了跳过，3 分钟没反应，后面几十家「去登录」全被拒）。
 */
async function prepareOrSkip(deps: JourneyDeps, page: JourneyPage, signal: AbortSignal): Promise<'skipped' | 'cancelled' | null> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  let done = false;
  const prep = prepareSms(deps, page, signal).finally(() => { done = true; });
  // 马上就能做完的准备（多数情况）不进轮询
  await Promise.race([prep, new Promise<void>(r => setImmediate(r))]);
  while (!done) {
    if (cancelled) { abandoned.add(page); return 'cancelled'; }
    if (skipRequested) { skipRequested = false; abandoned.add(page); return 'skipped'; }
    await Promise.race([prep, sleep(deps.pollMs ?? POLL_MS)]);
  }
  return null;
}

interface Step { h: Handoff; actionId: string; appKey: string; site: string | null; url?: string; company?: string }

function stepOf(repos: Repos, handoffId: string): Step | null {
  const h = repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [handoffId]);
  if (!h || h.resumed_at || !h.action_id) return null;
  const action = repos.getAction(h.action_id);
  if (!action) return null;
  let url: string | undefined;
  try { url = (JSON.parse(action.payload_json) as { url?: unknown }).url as string | undefined; } catch (e) { console.warn(`[career] login-journey: 动作 ${action.id} payload 解析失败`, e); }
  const app = action.application_id ? repos.getApplication(action.application_id) : undefined;
  const company = app ? repos.getJob(app.job_id)?.company_name ?? undefined : undefined;
  return { h, actionId: action.id, appKey: action.application_id ?? action.id, site: typeof url === 'string' ? siteOf(url) : null, ...(typeof url === 'string' ? { url } : {}), ...(company ? { company } : {}) };
}

/**
 * 页面没了（学生关掉了窗口 / 标签，或一开始就找不到）：关掉这家的接管，交给后台从岗位网址重新打开；
 * 重开后撞到登录会生成新的接管，等你条里再出现。不在这里干等（2026-10-31：等满 3 分钟、画面一直是空的）。
 */
function reopen(deps: JourneyDeps, step: Step): void {
  const fresh = deps.repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [step.h.id]);
  if (fresh && !fresh.resumed_at) deps.repos.closeHandoff(step.h.id, 'page_closed');
  BatchRunner.command(deps.repos, 'run', 'login-journey', [step.actionId]);
  deps.changed(['handoff', 'action_queue', 'task']);
}

/**
 * 页面没了：直接打开这家的网址，就在这一家登录（2026-11-03：App 一重启网页全关，原来交给后台整批重开，
 * 等你里又合成「N 个网站等你过一下」，他点哪家都不是那家）。打不开再交给后台。
 */
async function openStepPage(deps: JourneyDeps, step: Step): Promise<JourneyPage | undefined> {
  if (!step.url || !deps.browser.openPage) return undefined;
  try { return await deps.browser.openPage(step.appKey, step.url); } catch (e) {
    console.warn(`[career] login-journey: 打开 ${step.url} 失败（${step.appKey}），交给后台重开`, e instanceof Error ? e.message : e);
    return undefined;
  }
}

/** 放行这一家：关接管（你点交还时已经关了）、记凭证名、交给后台接着填。 */
function release(deps: JourneyDeps, step: Step, credentials: string[]): void {
  const fresh = deps.repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [step.h.id]);
  if (fresh && !fresh.resumed_at) deps.repos.closeHandoff(step.h.id, 'login_detected');
  if (step.site) {
    learnLoginMarks(deps.repos, step.site, credentials);
    void deps.browser.rememberLogin?.(step.site).catch(e => console.warn(`[career] login-journey: 记会话 Cookie 失败（${step.site}）`, e instanceof Error ? e.message : e));
  }
  BatchRunner.command(deps.repos, 'run', 'login-journey', [step.actionId]);
  deps.changed(['handoff', 'action_queue', 'task']);
}

async function waitForLogin(deps: JourneyDeps, step: Step, page: JourneyPage): Promise<{ outcome: StepOutcome; credentials: string[]; signal?: LoginSignal }> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const site = step.site ?? siteOf(page.url());
  const read = async () => (site ? authCookies(await deps.browser.cookies(), site) : new Map<string, string>());
  const judge = new LoginJudge(await read());
  const off = page.onLoginResponse(v => judge.response(v));
  const until = now() + (deps.timeoutMs ?? JOURNEY_STEP_TIMEOUT_MS);
  try {
    while (now() < until) {
      if (cancelled) return { outcome: 'cancelled', credentials: [] };
      if (skipRequested) { skipRequested = false; return { outcome: 'skipped', credentials: [] }; }
      if (page.closed()) return { outcome: 'page_closed', credentials: [] };
      checkStale(now());
      const j = judge.observe(await read(), await page.screen());
      if (j.state === 'logged_in') return { outcome: 'logged_in', credentials: j.credentials, signal: j.signal };
      if (deps.repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [step.h.id])?.resumed_at) return { outcome: 'handed_back', credentials: j.credentials };
      await sleep(deps.pollMs ?? POLL_MS);
    }
    return { outcome: 'timeout', credentials: [] };
  } finally { off(); }
}

/**
 * 他在这一家扫码、拖拼图时，下一家的网页先在后台打开（开一页要十几秒）：过完一家马上是下一家，接力不用等
 * （2026-11-05 用户：人机验证排成一串过）。只提前开一家，开不了到时候照常再开。
 */
function prefetchNext(deps: JourneyDeps, handoffIds: readonly string[], index: number, ahead: Map<string, Promise<JourneyPage | undefined>>): void {
  const next = handoffIds[index + 1];
  const step = next ? stepOf(deps.repos, next) : null;
  if (!step || ahead.has(step.appKey) || deps.browser.pageFor(step.appKey)) return;
  ahead.set(step.appKey, openStepPage(deps, step));
}

async function runSteps(deps: JourneyDeps, askId: string, handoffIds: readonly string[]): Promise<JourneyResult> {
  const result: JourneyResult = { steps: [] };
  const ahead = new Map<string, Promise<JourneyPage | undefined>>();
  for (const [index, id] of handoffIds.entries()) {
    const step = stepOf(deps.repos, id);
    if (!step) continue; // 别处已经处理了
    // 先钉住再开网页：开页要十几秒，这期间界面和「去登录」都要知道有一趟在走（2026-11-05：没钉住时状态报「没在登录」，
    // 接着点的几十家全被悄悄拒掉）
    setLivePin({ sessionKey: deps.sessionKey, appKey: step.appKey, askId, handoffId: id, index, total: handoffIds.length });
    journeyChanged();
    const page = deps.browser.pageFor(step.appKey) ?? await (ahead.get(step.appKey) ?? openStepPage(deps, step));
    ahead.delete(step.appKey);
    if (!page) { reopen(deps, step); result.steps.push({ handoff_id: id, outcome: 'no_page' }); continue; } // 开不了：交给后台重新打开
    if (step.site && knownLoggedIn(deps.repos, await deps.browser.cookies(), step.site)) {
      // 学过的凭证在，但页面上登录框还开着：那是学错了（2026-11-02 美团：滑块发的风控 Cookie 被当成登录凭证记下，
      // 之后每次都直接放行、后台又撞登录墙，永远轮不到你登录）。忘掉，这次让你真登一次
      const screen = await page.screen();
      if (!screen?.loginShown && !screen?.formShown) { release(deps, step, []); result.steps.push({ handoff_id: id, outcome: 'known' }); continue; }
      console.warn(`[career] login-journey: ${step.site} 学过的登录凭证还在，但页面仍要登录——忘掉重学`);
      forgetLoginMarks(deps.repos, step.site);
    }
    // 已经登上了（他自己登过 / 上一趟其实登上了没认出来，2026-11-03 中国中车）：直接放行，不再找登录框、不干等
    const now = await page.screen();
    if (now?.loggedIn && !now.formShown && !now.loginShown) { release(deps, step, []); result.steps.push({ handoff_id: id, outcome: 'known' }); console.log(`[career] login-journey step ${id} 画面上已经登上了，直接放行`); continue; }
    setLivePin({ sessionKey: deps.sessionKey, appKey: step.appKey, askId, handoffId: id, index, total: handoffIds.length });
    journeyChanged();
    deps.browser.focus(page);
    deps.changed(['handoff']);
    smsSite = step.company ?? step.site ?? undefined;
    prefetchNext(deps, handoffIds, index, ahead);
    // 这一家走完（登上 / 跳过 / 超时）就收掉它在后台盯手机的那一路，不占着手机等下一家
    const stepDone = new AbortController();
    const early = await prepareOrSkip(deps, page, stepDone.signal).finally(() => { if (cancelled || skipRequested) stepDone.abort(); });
    if (early) {
      stepDone.abort();
      sms = null;
      result.steps.push({ handoff_id: id, outcome: early });
      console.log(`[career] login-journey step ${id} outcome=${early}（准备阶段）`);
      if (early === 'skipped') continue;
      break;
    }
    const { outcome, credentials, signal } = await waitForLogin(deps, step, page).finally(() => stepDone.abort());
    if (outcome === 'logged_in' || outcome === 'handed_back') showDone(page); else sms = null;
    result.steps.push({ handoff_id: id, outcome, credentials, ...(signal ? { signal } : {}) });
    console.log(`[career] login-journey step ${id} outcome=${outcome} signal=${signal ?? '-'}`);
    if (outcome === 'logged_in' || outcome === 'handed_back') release(deps, step, credentials);
    else if (outcome === 'page_closed') reopen(deps, step); // 这家重开，接着下一家
    else if (outcome === 'skipped') continue; // 这家留在等你里，接着下一家
    else break;
  }
  return result;
}

/** 开始一次登录之旅（同一时间只有一趟）。返回 null 表示已经在走了。 */
export function startJourney(deps: JourneyDeps, askId: string, handoffIds: readonly string[]): Promise<JourneyResult> | null {
  if (running) return null;
  cancelled = false;
  skipRequested = false;
  smsChanged = deps.changed;
  // 他在登录之旅开始前就接管着（正在页面上操作）：旅程结束不收回，不然他手下的画面突然不听使唤（2026-11-05 汉高滚不动）
  const heldByUser = deps.browser.control() === 'human';
  running = runSteps(deps, askId, handoffIds).finally(() => {
    setLivePin(null);
    journeyChanged();
    if (sms?.state.status !== 'logged_in') sms = null; // 「X 已登录」留一会儿让他看到
    if (!heldByUser && deps.browser.control() === 'human') deps.browser.releaseControl();
    running = null;
    deps.changed(['handoff']);
  });
  return running;
}

