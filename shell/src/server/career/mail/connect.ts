/**
 * 一键连接邮箱：在产品浏览器里打开邮箱官方页面，用户扫码登录、按提示验证，页面上一出现授权码就自动读出来、
 * 先用 IMAP 登录验证、再绑定。授权码只在 Global 侧车内存里走一遍，不进对话、不进日志。
 *
 * QQ / 163 / 126 没有对第三方开放的 OAuth，Gmail 的 OAuth 要注册应用并过审，所以这里都走「官方页面生成授权码 /
 * 应用专用密码 → 自动读取」：用户要做的只剩扫码和官方要求的那一步验证，不用复制粘贴、不用填地址。
 * 页面导航是尽力而为（按文字点「设置」「生成授权码」），点不到时用户可以直接在弹窗的实时画面里自己点。
 */
import { randomUUID } from 'crypto';

import type { MailProvider } from '@career/core';

export type ConnectProvider = Extract<MailProvider, 'qq' | '163' | '126' | 'gmail'>;
export const CONNECT_PROVIDERS: readonly ConnectProvider[] = ['qq', '163', '126', 'gmail'];

export type ConnectStatus = 'starting' | 'login' | 'settings' | 'need_address' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface MailConnectSession {
  id: string;
  provider: ConnectProvider;
  status: ConnectStatus;
  /** 这一步要用户做什么（给弹窗显示）。 */
  hint: string;
  address: string | null;
  account_id: string | null;
  /** 完成时的一句话（拉到几封）。 */
  summary: string | null;
  error: string | null;
  started_at: string;
  updated_at: string;
}

export interface ConnectRecipe {
  provider: ConnectProvider;
  label: string;
  startUrl: string;
  isLoggedIn(url: string): boolean;
  loginHint: string;
  codeHint: string;
  /** 登录后依次尝试点击的文字：越靠前越接近授权码，每个文字在同一页面只点一次。 */
  clickPath: string[];
  /** 只点一次的按钮（会触发官方验证，重复点会反复弹窗）。 */
  clickOnce: string[];
  codeKeywords: RegExp;
  codePattern: RegExp;
  addressPattern: RegExp;
}

export const RECIPES: Record<ConnectProvider, ConnectRecipe> = {
  qq: {
    provider: 'qq', label: 'QQ 邮箱', startUrl: 'https://mail.qq.com/',
    isLoggedIn: url => /(?:wx\.)?mail\.qq\.com\//.test(url) && /[?&#]sid=|\/home\/|\/list\/|\/account\/|frame_html/.test(url),
    loginHint: '用手机 QQ 或微信扫码登录 QQ 邮箱',
    codeHint: '正在打开「生成授权码」。弹出验证时按提示用手机 QQ 邮箱 App 扫码或发一条短信，授权码出来后会自动读取，不用复制',
    clickPath: ['生成授权码', '开启服务', '账号与安全', '安全设置', '账户', '设置'],
    clickOnce: ['生成授权码', '开启服务'],
    codeKeywords: /授权码/,
    codePattern: /(?<![A-Za-z])[a-z]{16}(?![A-Za-z])/g,
    addressPattern: /[A-Za-z0-9._-]+@(?:vip\.)?(?:qq|foxmail)\.com/g,
  },
  '163': {
    provider: '163', label: '网易 163 邮箱', startUrl: 'https://mail.163.com/',
    isLoggedIn: url => /mail\.163\.com\/js6\/|[?&]sid=/.test(url),
    loginHint: '用网易邮箱大师 App 扫码，或输入账号密码登录 163 邮箱',
    codeHint: '正在打开「POP3/SMTP/IMAP」设置。开启 IMAP 或点「新增授权密码」，按提示发短信验证，授权码出来后会自动读取',
    clickPath: ['新增授权密码', 'POP3/SMTP/IMAP', '设置'],
    clickOnce: ['新增授权密码'],
    codeKeywords: /授权码|授权密码/,
    codePattern: /(?<![A-Za-z0-9])[A-Z]{16}(?![A-Za-z0-9])/g,
    addressPattern: /[A-Za-z0-9._-]+@163\.com/g,
  },
  '126': {
    provider: '126', label: '网易 126 邮箱', startUrl: 'https://mail.126.com/',
    isLoggedIn: url => /mail\.126\.com\/js6\/|[?&]sid=/.test(url),
    loginHint: '用网易邮箱大师 App 扫码，或输入账号密码登录 126 邮箱',
    codeHint: '正在打开「POP3/SMTP/IMAP」设置。开启 IMAP 或点「新增授权密码」，按提示发短信验证，授权码出来后会自动读取',
    clickPath: ['新增授权密码', 'POP3/SMTP/IMAP', '设置'],
    clickOnce: ['新增授权密码'],
    codeKeywords: /授权码|授权密码/,
    codePattern: /(?<![A-Za-z0-9])[A-Z]{16}(?![A-Za-z0-9])/g,
    addressPattern: /[A-Za-z0-9._-]+@(?:126\.com|yeah\.net)/g,
  },
  gmail: {
    provider: 'gmail', label: 'Gmail', startUrl: 'https://myaccount.google.com/apppasswords',
    isLoggedIn: url => url.startsWith('https://myaccount.google.com/'),
    loginHint: '登录你的 Google 账号（需要已开启两步验证）',
    codeHint: '在「应用专用密码」页随便起个名字（比如「求职助手」）点「创建」，16 位密码出来后会自动读取。看不到这个页面说明还没开两步验证',
    clickPath: [],
    clickOnce: [],
    codeKeywords: /应用专用密码|app password/i,
    codePattern: /(?<![a-z])[a-z]{4} [a-z]{4} [a-z]{4} [a-z]{4}(?![a-z])|(?<![A-Za-z])[a-z]{16}(?![A-Za-z])/g,
    addressPattern: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail)\.com/g,
  },
};

export function isConnectProvider(value: unknown): value is ConnectProvider {
  return typeof value === 'string' && (CONNECT_PROVIDERS as readonly string[]).includes(value);
}

/** 授权码只认关键词附近的：整页随便一串 16 位字母不算。 */
export function findAuthCodes(text: string, recipe: Pick<ConnectRecipe, 'codeKeywords' | 'codePattern'>): string[] {
  const out: string[] = [];
  const keyword = new RegExp(recipe.codeKeywords.source, recipe.codeKeywords.flags.includes('g') ? recipe.codeKeywords.flags : `${recipe.codeKeywords.flags}g`);
  for (const hit of text.matchAll(keyword)) {
    const start = Math.max(0, (hit.index ?? 0) - 120);
    const window = text.slice(start, (hit.index ?? 0) + hit[0].length + 240);
    for (const m of window.matchAll(new RegExp(recipe.codePattern.source, recipe.codePattern.flags))) {
      const code = m[0].replace(/\s+/g, '');
      if (!out.includes(code)) out.push(code);
    }
  }
  return out;
}

/** 页面上出现最多的那个邮箱地址（登录后页头 / 设置页都会显示自己的地址）。 */
export function findAddress(text: string, recipe: Pick<ConnectRecipe, 'addressPattern'>): string | null {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(new RegExp(recipe.addressPattern.source, recipe.addressPattern.flags))) {
    const a = m[0].toLowerCase();
    counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [a, n] of counts) if (!best || n > (counts.get(best) ?? 0)) best = a;
  return best;
}

/** 连接流程需要的页面能力（Playwright 适配见 connect-browser.ts，测试用假页面）。 */
export interface ConnectPage {
  url(): string;
  goto(url: string): Promise<void>;
  /** 所有 frame 的可见文字拼起来。 */
  text(): Promise<string>;
  /** 点一个文字完全相同、当前可见的元素；点到了返回 true。 */
  clickText(text: string): Promise<boolean>;
}

export interface ConnectDeps {
  /** 借一个页面跑完整个流程（Global：产品浏览器开新页、设为现场画面、交给用户控制）。 */
  withPage(fn: (page: ConnectPage) => Promise<void>): Promise<void>;
  /** 用授权码试登录 IMAP；失败抛错。 */
  verifyLogin(provider: ConnectProvider, address: string, code: string): Promise<void>;
  /** 验证通过后正式绑定并首次同步。 */
  bind(provider: ConnectProvider, address: string, code: string): Promise<{ account_id: string; summary: string }>;
  tickMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Runner { session: MailConnectSession; abort: AbortController; address: string | null }

const runners = new Map<string, Runner>();
const FINAL: ReadonlySet<ConnectStatus> = new Set(['done', 'failed', 'cancelled']);

function update(r: Runner, patch: Partial<MailConnectSession>): void {
  Object.assign(r.session, patch, { updated_at: new Date().toISOString() });
}

export function getMailConnect(id: string): MailConnectSession | null {
  const r = runners.get(id);
  return r ? { ...r.session } : null;
}

export function cancelMailConnect(id: string): MailConnectSession | null {
  const r = runners.get(id);
  if (!r) return null;
  if (!FINAL.has(r.session.status)) {
    r.abort.abort();
    update(r, { status: 'cancelled', hint: '已取消' });
  }
  return { ...r.session };
}

/** 页面上没认出地址时，用户在弹窗里补一个。 */
export function provideConnectAddress(id: string, address: string): MailConnectSession | null {
  const r = runners.get(id);
  if (!r) return null;
  r.address = address.trim().toLowerCase();
  update(r, { address: r.address });
  return { ...r.session };
}

export function startMailConnect(deps: ConnectDeps, provider: ConnectProvider, opts: { address?: string | null } = {}): MailConnectSession {
  // 同一时间只跑一个连接：新的开始前把旧的取消
  for (const [id, r] of runners) {
    if (!FINAL.has(r.session.status)) cancelMailConnect(id);
    else runners.delete(id);
  }
  const recipe = RECIPES[provider];
  const now = new Date().toISOString();
  const address = opts.address?.trim().toLowerCase() || null;
  const runner: Runner = {
    session: { id: randomUUID(), provider, status: 'starting', hint: `正在打开${recipe.label}`, address, account_id: null, summary: null, error: null, started_at: now, updated_at: now },
    abort: new AbortController(),
    address,
  };
  runners.set(runner.session.id, runner);
  void deps.withPage(page => drive(deps, recipe, runner, page)).catch(error => {
    if (FINAL.has(runner.session.status)) return;
    update(runner, { status: 'failed', error: error instanceof Error ? error.message : String(error), hint: '没能打开浏览器' });
  });
  return { ...runner.session };
}

async function drive(deps: ConnectDeps, recipe: ConnectRecipe, r: Runner, page: ConnectPage): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const tick = deps.tickMs ?? 1500;
  const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);
  const rejected = new Set<string>();
  const clicked = new Set<string>();
  const clickedOnce = new Set<string>();
  let pending: string | null = null;

  await page.goto(recipe.startUrl);
  update(r, { status: 'login', hint: recipe.loginHint });

  while (!r.abort.signal.aborted) {
    if (Date.now() > deadline) {
      update(r, { status: 'failed', error: '等了 10 分钟还没拿到授权码', hint: '超时了，可以重新连接，或改用手动填写授权码' });
      return;
    }
    const text = await page.text().catch(() => '');
    const url = page.url();
    if (!r.address) {
      const seen = findAddress(text, recipe);
      if (seen) { r.address = seen; update(r, { address: seen }); }
    }

    const code: string | null = pending ?? findAuthCodes(text, recipe).find(c => !rejected.has(c)) ?? null;
    if (code) {
      if (!r.address) {
        pending = code;
        if (r.session.status !== 'need_address') update(r, { status: 'need_address', hint: '读到授权码了，但页面上没认出你的邮箱地址，填一下就好' });
        await sleep(tick);
        continue;
      }
      pending = null;
      update(r, { status: 'verifying', hint: '读到授权码，正在登录邮箱验证…' });
      try {
        await deps.verifyLogin(recipe.provider, r.address, code);
      } catch (error) {
        rejected.add(code);
        update(r, { status: 'settings', hint: recipe.codeHint, error: `这串授权码登录失败：${error instanceof Error ? error.message : String(error)}。可以再生成一个` });
        await sleep(tick);
        continue;
      }
      if (r.abort.signal.aborted) return;
      const bound = await deps.bind(recipe.provider, r.address, code);
      update(r, { status: 'done', account_id: bound.account_id, summary: bound.summary, error: null, hint: `已连接 ${r.address}` });
      return;
    }

    if (recipe.isLoggedIn(url)) {
      if (r.session.status === 'login' || r.session.status === 'starting') update(r, { status: 'settings', hint: recipe.codeHint });
      for (const target of recipe.clickPath) {
        const once = recipe.clickOnce.includes(target);
        const key = once ? target : `${url}::${target}`;
        if ((once ? clickedOnce : clicked).has(key)) continue;
        if (await page.clickText(target).catch(() => false)) {
          (once ? clickedOnce : clicked).add(key);
          break;
        }
      }
    }
    await sleep(tick);
  }
}

/** 测试用：清空内存里的连接。 */
export function resetMailConnects(): void {
  for (const r of runners.values()) r.abort.abort();
  runners.clear();
}

/** Playwright 页面 → ConnectPage（只用结构类型，不在运行时引 playwright）。 */
interface PlaywrightFrameLike {
  evaluate<R>(fn: () => R): Promise<R>;
  getByText(text: string, options: { exact: boolean }): { count(): Promise<number>; nth(i: number): { isVisible(): Promise<boolean>; click(options: { timeout: number }): Promise<void> } };
}
interface PlaywrightPageLike {
  url(): string;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  frames(): PlaywrightFrameLike[];
}

export function fromPlaywrightPage(page: PlaywrightPageLike): ConnectPage {
  return {
    url: () => page.url(),
    goto: async url => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); },
    text: async () => {
      const parts = await Promise.all(page.frames().map(f => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')));
      return parts.join('\n');
    },
    clickText: async text => {
      for (const frame of page.frames()) {
        const loc = frame.getByText(text, { exact: true });
        const n = Math.min(await loc.count().catch(() => 0), 5);
        for (let i = 0; i < n; i++) {
          const el = loc.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;
          await el.click({ timeout: 2_000 });
          return true;
        }
      }
      return false;
    },
  };
}
