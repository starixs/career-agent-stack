/**
 * 登录之旅（规范 §5.2「两个网站要登录，一次登录之旅算一件」；用户 2026-10-30 定）：
 * 等你条里「N 个网站要你登录」点「去登录」→ 现场画面一家一家带你过。
 *
 *  1. 切到一家之前，先看这个站学过的登录凭证还在不在（login-signal.knownLoggedIn），在就直接放行这家，不让你看；
 *  2. 否则把画面和你的操作钉在这一家（live-pin），记下这个站此刻的凭证；
 *  3. 等：这个站发下了新的会话凭证、而且登录类请求没有返回失败（数据层，不看画面）——或者你点了「交还」；
 *  4. 登上了：关掉这家的接管、记下凭证名、交给后台从原页接着填，切下一家；
 *  5. 一家等太久（默认 3 分钟）或你点「晚点」：停在这里，剩下的留在等你条里。
 * 后台其余几家照样并行填（不抢画面）。浏览器对象由 JourneyBrowser 给，便于测试。
 */
import type { Handoff, Repos } from '@career/core';

import { siteOf } from './app-pages';
import { BatchRunner } from './batch-runner';
import { setLivePin } from './live-pin';
import { authCookies, knownLoggedIn, learnLoginMarks, loggedIn, newCredentials, type CookieLike, type ResponseVerdict } from './login-signal';

export interface JourneyPage { url(): string; onLoginResponse(cb: (verdict: ResponseVerdict) => void): () => void }
export interface JourneyBrowser {
  cookies(): Promise<CookieLike[]>;
  pageFor(appKey: string): JourneyPage | undefined;
  /** 把画面切到这一页（强制）。 */
  focus(page: JourneyPage): void;
  /** 用户此刻是否在接管。 */
  control(): 'agent' | 'human';
  /** 收尾：控制权还给助理。 */
  releaseControl(): void;
}
export interface JourneyDeps {
  repos: Repos; browser: JourneyBrowser; sessionKey: string;
  changed: (tables: string[]) => void;
  pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}
export type StepOutcome = 'known' | 'logged_in' | 'handed_back' | 'timeout' | 'cancelled' | 'no_page';
export interface JourneyResult { steps: Array<{ handoff_id: string; outcome: StepOutcome; credentials?: string[] }> }

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

/** 放行这一家：关接管（你点交还时已经关了）、记凭证名、交给后台接着填。 */
function release(deps: JourneyDeps, step: Step, credentials: string[]): void {
  const fresh = deps.repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [step.h.id]);
  if (fresh && !fresh.resumed_at) deps.repos.closeHandoff(step.h.id, 'login_detected');
  if (step.site) learnLoginMarks(deps.repos, step.site, credentials);
  BatchRunner.command(deps.repos, 'run', 'login-journey', [step.actionId]);
  deps.changed(['handoff', 'action_queue', 'task']);
}

async function waitForLogin(deps: JourneyDeps, step: Step, page: JourneyPage): Promise<{ outcome: StepOutcome; credentials: string[] }> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const site = step.site ?? siteOf(page.url());
  const before = site ? authCookies(await deps.browser.cookies(), site) : new Map<string, string>();
  let last: ResponseVerdict = null;
  const off = page.onLoginResponse(v => { if (v) last = v; });
  const until = now() + (deps.timeoutMs ?? JOURNEY_STEP_TIMEOUT_MS);
  try {
    while (now() < until) {
      if (cancelled) return { outcome: 'cancelled', credentials: [] };
      const fresh = site ? newCredentials(before, authCookies(await deps.browser.cookies(), site)) : [];
      if (loggedIn(fresh, last)) return { outcome: 'logged_in', credentials: fresh };
      if (deps.repos.db.get<Handoff>('SELECT * FROM handoff WHERE id=?', [step.h.id])?.resumed_at) return { outcome: 'handed_back', credentials: fresh };
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
    if (!page) { result.steps.push({ handoff_id: id, outcome: 'no_page' }); continue; } // 页面没了：留给后台重新打开
    if (step.site && knownLoggedIn(deps.repos, await deps.browser.cookies(), step.site)) {
      release(deps, step, []); result.steps.push({ handoff_id: id, outcome: 'known' }); continue;
    }
    setLivePin({ sessionKey: deps.sessionKey, appKey: step.appKey, askId, handoffId: id, index, total: handoffIds.length });
    deps.browser.focus(page);
    deps.changed(['handoff']);
    const { outcome, credentials } = await waitForLogin(deps, step, page);
    result.steps.push({ handoff_id: id, outcome, credentials });
    if (outcome === 'logged_in' || outcome === 'handed_back') release(deps, step, credentials);
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

