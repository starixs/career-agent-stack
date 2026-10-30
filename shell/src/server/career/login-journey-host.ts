/**
 * 登录之旅接到真实托管浏览器（Global 侧车）：Cookie 从浏览器上下文读，登录类请求的返回从那一页的网络响应听，画面从那一页读，
 * 画面切换走宿主的 focusPage。整趟持有一个会话租约，免得中途上下文被回收。
 */
import type { Repos } from '@career/core';
import type { BrowserContext, Page } from 'playwright';

import { findApplicationPage } from './app-pages';
import { careerBrowserHost } from './batch-service';
import { liveHub } from './live-hub';
import { rememberSessionCookies } from './session-cookies';
import { journeyRunning, startJourney, type JourneyBrowser, type JourneyPage } from './login-journey';
import { onLoginResponse, screenSample } from './login-watch';

function journeyPage(page: Page): JourneyPage {
  return { url: () => page.url(), onLoginResponse: cb => onLoginResponse(page, cb), screen: () => screenSample(page) };
}

function browserOf(context: BrowserContext, host: Awaited<ReturnType<typeof careerBrowserHost>>['host'], id: string): JourneyBrowser {
  const pages = new WeakMap<JourneyPage, Page>();
  return {
    cookies: () => context.cookies(),
    pageFor: appKey => {
      const page = findApplicationPage(context, id, appKey);
      if (!page) return undefined;
      const jp = journeyPage(page);
      pages.set(jp, page);
      return jp;
    },
    focus: jp => { const page = pages.get(jp); if (page) host.focusPage(id, page); },
    reveal: async jp => {
      const page = pages.get(jp);
      if (!page) return;
      host.focusPage(id, page);
      await page.bringToFront();
      // 和「显示真实窗口」按钮同一条事件：现场抽屉据此改提示、切按钮
      liveHub.publish('career:live-window', { sessionId: id, ...(await host.setWindowVisible(id, true)) });
    },
    rememberLogin: async site => { await rememberSessionCookies(context, site); },
    conceal: async () => { liveHub.publish('career:live-window', { sessionId: id, ...(await host.setWindowVisible(id, false)) }); },
    control: () => host.getControl(id).control,
    releaseControl: () => { host.setControl(id, 'agent'); },
  };
}

/** 开始一趟（后台跑，不等它走完）。已经在走了返回 false。 */
export async function beginLoginJourney(repos: Repos, askId: string, handoffIds: readonly string[], changed: (tables: string[]) => void): Promise<boolean> {
  if (journeyRunning()) return false;
  const { host, productSessionId: id } = await careerBrowserHost();
  void host.withProductSession(id, async context => {
    await startJourney({ repos, browser: browserOf(context, host, id), sessionKey: id, changed }, askId, handoffIds);
  }, { allowHumanControl: true }).then(
    () => console.log(`[career] login-journey ${askId} 结束`),
    (e: unknown) => console.error(`[career] login-journey FAILED ${askId}`, e instanceof Error ? e.message : e),
  );
  return true;
}
