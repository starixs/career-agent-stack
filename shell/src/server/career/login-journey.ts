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
import { setLivePin } from './live-pin';
import { authCookies, forgetLoginMarks, knownLoggedIn, learnLoginMarks, LoginJudge, type CookieLike, type LoginSignal, type ResponseVerdict, type ScreenSample } from './login-signal';

export interface JourneyPage {
  url(): string; onLoginResponse(cb: (verdict: ResponseVerdict) => void): () => void; /** 画面这一路；读不到给 null */ screen(): Promise<ScreenSample | null>;
  /** 页面被关掉了（学生关了窗口 / 标签）。 */
  closed(): boolean;
}
export interface JourneyBrowser {
  cookies(): Promise<CookieLike[]>;
  pageFor(appKey: string): JourneyPage | undefined;
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
export type StepOutcome = 'known' | 'logged_in' | 'handed_back' | 'timeout' | 'cancelled' | 'no_page' | 'page_closed';
export interface JourneyResult { steps: Array<{ handoff_id: string; outcome: StepOutcome; credentials?: string[]; signal?: LoginSignal }> }

/** 一家最多等多久：扫码 + 手机确认、等短信码，三分钟够了；再长就停下，剩下的留在等你条里。 */
export const JOURNEY_STEP_TIMEOUT_MS = 180_000;
const POLL_MS = 1500;

let cancelled = false;
let running: Promise<JourneyResult> | null = null;
export const journeyRunning = () => running !== null;
export function cancelJourney(): void { cancelled = true; }

interface Step { h: Handoff; actionId: string; appKey: string; site: string | null }

function stepOf(repos: Repos, handoffId: string): Step | null {
  const h = repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [handoffId]);
  if (!h || h.resumed_at || !h.action_id) return null;
  const action = repos.getAction(h.action_id);
  if (!action) return null;
  let url: string | undefined;
  try { url = (JSON.parse(action.payload_json) as { url?: unknown }).url as string | undefined; } catch (e) { console.warn(`[career] login-journey: 动作 ${action.id} payload 解析失败`, e); }
  return { h, actionId: action.id, appKey: action.application_id ?? action.id, site: typeof url === 'string' ? siteOf(url) : null };
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
      if (page.closed()) return { outcome: 'page_closed', credentials: [] };
      const j = judge.observe(await read(), await page.screen());
      if (j.state === 'logged_in') return { outcome: 'logged_in', credentials: j.credentials, signal: j.signal };
      if (deps.repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [step.h.id])?.resumed_at) return { outcome: 'handed_back', credentials: j.credentials };
      await sleep(deps.pollMs ?? POLL_MS);
    }
    return { outcome: 'timeout', credentials: [] };
  } finally { off(); }
}

async function runSteps(deps: JourneyDeps, askId: string, handoffIds: readonly string[]): Promise<JourneyResult> {
  const result: JourneyResult = { steps: [] };
  for (const [index, id] of handoffIds.entries()) {
    const step = stepOf(deps.repos, id);
    if (!step) continue; // 别处已经处理了
    const page = deps.browser.pageFor(step.appKey);
    if (!page) { reopen(deps, step); result.steps.push({ handoff_id: id, outcome: 'no_page' }); continue; } // 页面没了：交给后台重新打开
    if (step.site && knownLoggedIn(deps.repos, await deps.browser.cookies(), step.site)) {
      // 学过的凭证在，但页面上登录框还开着：那是学错了（2026-11-02 美团：滑块发的风控 Cookie 被当成登录凭证记下，
      // 之后每次都直接放行、后台又撞登录墙，永远轮不到你登录）。忘掉，这次让你真登一次
      const screen = await page.screen();
      if (!screen?.loginShown && !screen?.formShown) { release(deps, step, []); result.steps.push({ handoff_id: id, outcome: 'known' }); continue; }
      console.warn(`[career] login-journey: ${step.site} 学过的登录凭证还在，但页面仍要登录——忘掉重学`);
      forgetLoginMarks(deps.repos, step.site);
    }
    setLivePin({ sessionKey: deps.sessionKey, appKey: step.appKey, askId, handoffId: id, index, total: handoffIds.length });
    deps.browser.focus(page);
    deps.changed(['handoff']);
    const { outcome, credentials, signal } = await waitForLogin(deps, step, page);
    result.steps.push({ handoff_id: id, outcome, credentials, ...(signal ? { signal } : {}) });
    console.log(`[career] login-journey step ${id} outcome=${outcome} signal=${signal ?? '-'}`);
    if (outcome === 'logged_in' || outcome === 'handed_back') release(deps, step, credentials);
    else if (outcome === 'page_closed') reopen(deps, step); // 这家重开，接着下一家
    else break;
  }
  return result;
}

/** 开始一次登录之旅（同一时间只有一趟）。返回 null 表示已经在走了。 */
export function startJourney(deps: JourneyDeps, askId: string, handoffIds: readonly string[]): Promise<JourneyResult> | null {
  if (running) return null;
  cancelled = false;
  running = runSteps(deps, askId, handoffIds).finally(() => {
    setLivePin(null);
    if (deps.browser.control() === 'human') deps.browser.releaseControl();
    running = null;
    deps.changed(['handoff']);
  });
  return running;
}

