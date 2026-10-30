/**
 * 请用户帮一下，做完接着办（世界模型 §4，2026-10-30）：扫码登录、短信码、二次验证这类只有他能做的事，
 * 不算任务失败。把现场画面交给他之后，这里盯着页面：等登录时先看数据层（网站发下了新的会话凭证，login-watch），
 * 再看挡路的东西（登录框 / 验证码）没了，或者他点了「交还」，
 * 就把新页面交回模型继续；到时没做完也只是「还在等」，由模型告诉他做完说一声。
 */
import type { Page } from 'playwright';

import { detectHints, inPage, type Hint, type RawObservation } from './browse';

export type WaitStatus = 'done' | 'handed_back' | 'timeout' | 'page_closed';
/** done 是凭什么判的：credentials = 网站发下了新的会话凭证（数据层，优先）；screen = 挡路的提示没了；url = 地址变了。 */
export interface WaitOutcome { status: WaitStatus; waited_ms: number; url: string; hints: Hint[]; signal?: 'credentials' | 'screen' | 'url'; credentials?: string[] }
export interface WaitOptions {
  /** 等哪些提示消失；空 = 等地址变化（比如登录完跳回原页）。 */
  blocking: Hint[];
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 用户点了「交还」（接管后又交回给助理）。 */
  handedBack?: () => boolean;
  /** 等登录时的数据层判断（login-watch.watchLogin）：返回新凭证名，空 = 还没登上。比看画面优先。 */
  credentials?: () => Promise<string[]>;
}

/** 默认等多久：扫码 + 手机确认一般一分钟内，短信码要等短信，给足三分钟。 */
export const WAIT_USER_DEFAULT_MS = 180_000;
/** 上限：再长就该结束这一轮，让他做完了说一声。 */
export const WAIT_USER_MAX_MS = 600_000;
const POLL_MS = 1500;
/** 连续这么多次看到挡路的东西没了才算完（登录跳转途中会闪一下）。 */
const CLEAR_STREAK = 2;

/** 页内：判提示要用的那几样。不能引用外部变量。 */
export function hintSampleInPage(): Pick<RawObservation, 'url' | 'hasPassword' | 'bodySample'> {
  return { url: location.href, hasPassword: !!document.querySelector('input[type=password]'), bodySample: (document.body?.innerText || '').slice(0, 3000) };
}

export async function waitForUser(page: Page, opts: WaitOptions): Promise<WaitOutcome> {
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();
  const startUrl = page.url();
  let streak = 0;
  let last: WaitOutcome = { status: 'timeout', waited_ms: 0, url: startUrl, hints: [] };
  for (;;) {
    if (page.isClosed()) return { ...last, status: 'page_closed', waited_ms: now() - start };
    const fresh = opts.credentials ? await opts.credentials() : [];
    if (fresh.length) return { status: 'done', waited_ms: now() - start, url: page.url(), hints: [], signal: 'credentials', credentials: fresh };
    const sample = await inPage(page, hintSampleInPage, null);
    const hints = detectHints(sample, []);
    const cleared = opts.blocking.length ? opts.blocking.every(h => !hints.includes(h)) : sample.url !== startUrl;
    streak = cleared ? streak + 1 : 0;
    last = { status: 'timeout', waited_ms: now() - start, url: sample.url, hints };
    if (streak >= CLEAR_STREAK) return { ...last, status: 'done', signal: opts.blocking.length ? 'screen' : 'url' };
    if (opts.handedBack?.()) return { ...last, status: 'handed_back' };
    if (now() - start >= opts.timeoutMs) return last;
    await sleep(opts.pollMs ?? POLL_MS);
  }
}
