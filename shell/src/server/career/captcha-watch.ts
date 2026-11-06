/**
 * 等他过验证码的那几家：页面上的验证码没了，就当他过完了——自动交还、接着往下填，不用他再点「交还」。
 * 2026-11-06 用户定：验证码先走我们自己的流程（自动过），走不通在上方显示给他，「填完之后然后去下一步」。
 *
 * 只看 captcha 原因的接管；登录由登录之旅（数据层 + 画面两路）判断，不在这里。
 * 判错也不会出事：续跑时引擎从当前页重新看，验证码还在就再停下来等他。
 */
import type { Handoff, Repos } from '@career/core';
import type { BrowserContext, Page } from 'playwright';

import { findApplicationPage } from './app-pages';

/** 接管开出来多久以后才开始看：刚弹出的验证码可能还没渲染出来，别一开就当成过了。 */
const MIN_WAIT_MS = 3000;

export interface CaptchaProbe {
  /** 这一页上还有没有验证码（DOM 里的验证码控件或页面文字里的验证提示）。 */
  stillThere(page: Page): Promise<boolean>;
}

export interface CaptchaWatchDeps {
  repos: Repos;
  sessionId: string;
  withContext: <T>(fn: (context: BrowserContext) => Promise<T>) => Promise<T>;
  probe: CaptchaProbe;
  now?: () => number;
}

function captchaWaits(repos: Repos, now: number): Array<{ handoff: Handoff; appKey: string }> {
  return repos.openHandoffs().flatMap(h => {
    if (h.reason !== 'captcha' || !h.action_id) return [];
    if (now - Date.parse(h.paused_at) < MIN_WAIT_MS) return [];
    const action = repos.getAction(h.action_id);
    return action?.kind === 'fill_form' && action.application_id ? [{ handoff: h, appKey: action.application_id }] : [];
  });
}

/** 过完验证码的接管关掉（批量运行器据此从当前页接着填）；返回关掉的接管 id。 */
export async function releaseClearedCaptchas(deps: CaptchaWatchDeps): Promise<string[]> {
  const waits = captchaWaits(deps.repos, deps.now?.() ?? Date.now());
  if (!waits.length) return [];
  const cleared: string[] = [];
  await deps.withContext(async context => {
    for (const { handoff, appKey } of waits) {
      const page = findApplicationPage(context, deps.sessionId, appKey);
      if (!page || page.isClosed()) continue;
      try {
        if (await deps.probe.stillThere(page)) continue;
      } catch (error) {
        console.warn(`[career] captcha-watch 看不了这一页 app=${appKey}`, error instanceof Error ? error.message : error);
        continue;
      }
      deps.repos.closeHandoff(handoff.id, 'captcha_cleared');
      cleared.push(handoff.id);
    }
  });
  return cleared;
}
