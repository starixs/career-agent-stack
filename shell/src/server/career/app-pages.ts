/**
 * 每份网申一个页面（Global 侧车进程内）。
 *
 * 填表停在提交前时，这份网申的页面要一直留着等审核 / 提交；批量投递填下一份时开新页，不能在同一页上跳走。
 * 借用代理（borrowBrowserContext）每次借用都会生成新的 Page 代理，所以这里用 `page.mainFrame()`（Playwright 缓存的
 * 同一个 Frame 对象）作为跨借用的页面身份，每次在当前借用的 `context.pages()` 里按它找回页面。
 *
 *  - start：这份网申已有页面就复用，否则开新页（唯一一页还是空白页时直接用它）；
 *  - continue / submit：必须找回原页面；continue 找不到时退回当前页（兼容旧接管），submit 找不到就报错；
 *  - 页面锁按页面身份：同一份网申不会被两处同时操作，不同网申的页面互不阻塞（阶段二并行的前提）。
 */
import type { BrowserContext, Page } from 'playwright';

import { activePage } from '../browser-host/page-control';

interface Entry { frame: object; key: string; openedAt: number }

const entries = new Map<string, Entry>();
const locks = new WeakMap<object, string>();
/** 页面身份：mainFrame（跨借用代理稳定）；没有 mainFrame 的测试替身用对象本身。 */
const identity = (page: Page): object => (typeof page.mainFrame === 'function' ? page.mainFrame() : page);

const slot = (sessionKey: string, appKey: string) => `${sessionKey}::${appKey}`;

function findLive(context: BrowserContext, frame: object): Page | undefined {
  return context.pages().find(p => !p.isClosed() && identity(p) === frame);
}

export type AppPageMode = 'start' | 'continue' | 'submit';

/** 主域名：zhaopin.meituan.com 与 passport.meituan.com 算同一个网站（登录常跳到同公司的单点登录域名）。 */
export function siteOf(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (!host || /^\d+(\.\d+){3}$/.test(host)) return host || null;
  const labels = host.replace(/^www\./, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  // .com.cn / .co.uk 这类二级后缀多取一段
  const sld = labels[labels.length - 2];
  const take = ['com', 'net', 'org', 'gov', 'edu', 'co', 'ac'].includes(sld) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}
const sameSite = (a: string, b: string) => { const x = siteOf(a); return !!x && x === siteOf(b); };

export async function pageForApplication(context: BrowserContext, sessionKey: string, appKey: string | undefined, mode: AppPageMode, opts: { siteUrl?: string } = {}): Promise<Page> {
  if (!appKey) return activePage(context);
  const key = slot(sessionKey, appKey);
  const existing = entries.get(key);
  const live = existing ? findLive(context, existing.frame) : undefined;
  if (live) {
    // 续跑前核对身份：用户接管时把这一页换到了别的网站，就不能在上面接着填
    if (mode === 'continue' && opts.siteUrl && !sameSite(live.url(), opts.siteUrl)) {
      throw Object.assign(new Error(`这份网申的页面现在停在 ${siteOf(live.url()) ?? live.url()}，不是网申网站 ${siteOf(opts.siteUrl)}。请回到网申页面后再交还，或者让助理重新打开这份网申。`), { name: 'APPLICATION_PAGE_MOVED' });
    }
    return live;
  }
  if (existing) entries.delete(key);
  if (mode === 'submit') throw Object.assign(new Error('这份网申填好的页面已经关闭（浏览器被关掉或重启过），需要重新填写后再提交'), { name: 'APPLICATION_PAGE_GONE' });
  if (mode === 'continue') {
    // 找不到原页面时才退回当前页，而且当前页必须在网申网站上；否则停下问，不在别的网站上乱填
    const page = await activePage(context);
    if (opts.siteUrl && !sameSite(page.url(), opts.siteUrl)) {
      throw Object.assign(new Error(`找不到这份网申的页面了，当前页面在 ${siteOf(page.url()) ?? (page.url() || '空白页')}，不是网申网站 ${siteOf(opts.siteUrl)}。请在浏览器里回到网申页面后再交还，或者让助理重新打开这份网申。`), { name: 'APPLICATION_PAGE_GONE' });
    }
    register(key, page);
    return page;
  }
  const open = context.pages().filter(p => !p.isClosed());
  const owned = new Set([...entries.values()].map(e => e.frame));
  const blank = open.find(p => !owned.has(identity(p)) && (p.url() === 'about:blank' || p.url() === ''));
  const page = blank ?? await context.newPage();
  register(key, page);
  return page;
}

function register(key: string, page: Page): void {
  const frame = identity(page);
  entries.set(key, { frame, key, openedAt: Date.now() });
  page.once('close', () => { if (entries.get(key)?.frame === frame) entries.delete(key); });
}

/** 这份网申结束（已提交 / 放弃 / 拒绝）：关掉它的页面。 */
export async function releaseApplicationPage(context: BrowserContext, sessionKey: string, appKey: string): Promise<void> {
  const key = slot(sessionKey, appKey);
  const e = entries.get(key);
  entries.delete(key);
  if (!e) return;
  const page = findLive(context, e.frame);
  // 至少留一个页面，否则 Chrome 窗口会随最后一页一起关闭
  if (page && context.pages().filter(p => !p.isClosed()).length > 1) await page.close().catch(() => { /* 已关闭 */ });
}

/** 当前登记着页面的网申（排查 / 状态展示用）。 */
export function openApplicationKeys(sessionKey: string): string[] {
  const prefix = `${sessionKey}::`;
  return [...entries.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
}

/** 页面锁：返回 null 表示拿到了；否则返回当前持有者。 */
export function lockPage(page: Page, owner: string): string | null {
  const id = identity(page);
  const holder = locks.get(id);
  if (holder && holder !== owner) return holder;
  locks.set(id, owner);
  return null;
}
export function unlockPage(page: Page, owner: string): void {
  const id = identity(page);
  if (locks.get(id) === owner) locks.delete(id);
}

/** 测试用。 */
export function resetApplicationPages(): void { entries.clear(); }
