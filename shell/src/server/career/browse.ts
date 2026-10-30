/**
 * 模型逐步操作浏览器（Global 侧车，托管 Chrome 上）：自己找岗位、翻列表、进详情、找投递入口。
 *
 * 设计（参考"感知 / 操作同源 + 回执即合同"）：
 *  - observe：给页面上可见的可操作元素编号，并在元素上打 `data-ks-ref="<观察编号>:<序号>"`；返回观察编号、元素清单、正文摘要。
 *  - act：必须带观察编号 + 元素序号。观察编号不是这一页最新的 → 拒绝（stale），要求先重新 observe，避免点错。
 *  - 回执：observed_effect（navigated / changed / no_change / unknown）、新开标签、retryable、required_next；
 *    结果不确定时 retryable=false，明确"不要重复操作，先 observe"——堵住模型失败后盲目重试。
 *  - 闸：提交 / 投递类按钮一律不点（走 收录岗位 → 冻结材料包 → 用户批准 → 填表引擎）；密码框只接受 {{vault:...}} 占位符；
 *    输入里的占位符在 Node 侧换成明文，模型永远看不到；同一网站两次操作之间拟人停顿。
 *  - 需要本人处理（登录框、验证码、风控页）时在观察结果里标出来，建议交给用户接管。
 */
import type { BrowserContext, Page } from 'playwright';

import { VERIFICATION_URL_RX, humanDrag, pointTargetInPage } from './browse-pointer';

// ---------- 页面内脚本（序列化后在浏览器里执行，不能引用外部变量） ----------
export interface RawElement { ref: number; kind: string; text: string; href?: string; inputType?: string; value?: string; checked?: boolean; disabled?: boolean; options?: string[]; inViewport: boolean; isPassword?: boolean }
export interface RawObservation { url: string; title: string; scrollY: number; scrollMax: number; viewportH: number; elements: RawElement[]; total: number; hasPassword: boolean; bodySample: string }

export function observeInPage(arg: { obsId: string; max: number }): RawObservation {
  const { obsId, max } = arg;
  document.querySelectorAll('[data-ks-ref]').forEach(el => el.removeAttribute('data-ks-ref'));
  const vh = window.innerHeight; const vw = window.innerWidth;
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el as HTMLElement);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const labelOf = (el: Element): string => {
    const h = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement>; placeholder?: string; value?: string };
    const aria = h.getAttribute('aria-label') || h.getAttribute('title') || '';
    const lbl = h.labels && h.labels.length ? h.labels[0].innerText : '';
    const inner = (h.innerText || '').replace(/\s+/g, ' ').trim();
    const alt = h.getAttribute('alt') || '';
    const ph = h.placeholder || '';
    const val = (h.tagName === 'INPUT' && ['submit', 'button'].includes((h as HTMLInputElement).type)) ? (h as HTMLInputElement).value : '';
    return (aria || inner || lbl || val || alt || ph).replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [role=option], [onclick], [contenteditable=true]';
  const all = Array.from(document.querySelectorAll(selector)).filter(visible);
  const scored = all.map(el => { const r = (el as HTMLElement).getBoundingClientRect(); return { el, inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw, top: r.top }; });
  scored.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.top - b.top);
  const elements: RawElement[] = [];
  let n = 0;
  for (const { el, inViewport } of scored) {
    if (elements.length >= max) break;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const input = el as HTMLInputElement;
    const kind = tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'input' ? (['checkbox', 'radio'].includes(input.type) ? input.type : ['submit', 'button', 'image', 'reset'].includes(input.type) ? 'button' : 'input') : role || (tag === 'button' ? 'button' : 'clickable');
    const text = labelOf(el);
    if (!text && kind !== 'input' && kind !== 'textarea' && kind !== 'select') continue;
    n += 1;
    el.setAttribute('data-ks-ref', `${obsId}:${n}`);
    const item: RawElement = { ref: n, kind, text, inViewport };
    if (tag === 'a') { const href = (el as HTMLAnchorElement).href; if (href && !href.startsWith('javascript:')) item.href = href.slice(0, 200); }
    if (tag === 'input' || tag === 'textarea') {
      item.inputType = tag === 'textarea' ? 'textarea' : input.type;
      item.isPassword = input.type === 'password';
      if (!item.isPassword && input.value) item.value = input.value.slice(0, 60);
      if (input.type === 'checkbox' || input.type === 'radio') item.checked = input.checked;
    }
    if (tag === 'select') item.options = Array.from((el as HTMLSelectElement).options).slice(0, 30).map(o => o.text.trim()).filter(Boolean);
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    elements.push(item);
  }
  return {
    url: location.href, title: document.title, scrollY: Math.round(window.scrollY), scrollMax: Math.max(0, Math.round(document.documentElement.scrollHeight - vh)), viewportH: vh,
    elements, total: all.length,
    hasPassword: !!document.querySelector('input[type=password]'),
    bodySample: (document.body?.innerText || '').slice(0, 3000),
  };
}

/**
 * 页面正文（观察摘要和分页读取共用）。正文容器取候选里字数最多的那个，且至少占全页一半，否则用整页：
 * 只取第一个匹配会命中导航条——美团、腾讯校招页的头部就叫 `.content` / `.main`，岗位列表全被漏掉。
 */
export function readInPage(arg: { offset: number; length: number }): { text: string; total: number } {
  const MAIN_MIN_SHARE = 0.5;
  const bodyText = document.body?.innerText || '';
  const candidates = Array.from(document.querySelectorAll('main, article, [role=main], #main, .main, .content')) as HTMLElement[];
  const best = candidates.reduce<HTMLElement | null>((a, c) => ((c.innerText || '').length > (a?.innerText || '').length ? c : a), null);
  const raw = best && best.innerText.length >= bodyText.length * MAIN_MIN_SHARE ? best.innerText : bodyText;
  const fullText = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text: fullText.slice(arg.offset, arg.offset + arg.length), total: fullText.length };
}

/** 页面变化签名（判断 act 有没有效果）。 */
export function signatureInPage(): string {
  const b = document.body;
  return `${location.href}|${b ? b.innerText.length : 0}|${document.querySelectorAll('*').length}|${Math.round(window.scrollY)}`;
}

/**
 * 把页面内函数送进浏览器执行。tsx / esbuild 为保留函数名会在函数体里插 `__name(...)`，
 * 序列化后浏览器里没有这个 helper 会直接 ReferenceError——所以先垫一个空实现。
 */
export async function inPage<A, R>(page: Pick<Page, 'evaluate'> & Partial<Pick<Page, 'waitForLoadState'>>, fn: (arg: A) => R, arg: A): Promise<R> {
  const src = `(() => { const __name = (f) => f; return (${fn.toString()})(${JSON.stringify(arg ?? null)}); })()`;
  try {
    return await (page.evaluate(src) as Promise<R>);
  } catch (error) {
    // 页面正在跳转（重定向、站内跳登录 / 首页）时上下文会被销毁：等新文档到了再执行一次，还不行就抛给调用方
    if (!CONTEXT_GONE_RX.test(String(error)) || !page.waitForLoadState) throw error;
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_SETTLE_TIMEOUT_MS });
    return page.evaluate(src) as Promise<R>;
  }
}

/** Playwright 调用日志里带终端颜色码，写进给模型的话之前去掉。 */
const ANSI_ESC = String.fromCharCode(27);
const CONTEXT_GONE_RX = /Execution context was destroyed|Cannot find context with specified id/;
/** 跳转中途等新文档的上限；和 act 里操作后等 domcontentloaded 用同一个值。 */
const NAV_SETTLE_TIMEOUT_MS = 5000;

export function scrollInPage(direction: 'up' | 'down'): void {
  window.scrollBy(0, (direction === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.8));
}

// ---------- Node 侧：观察记录、闸、回执 ----------
export interface ElementInfo { kind: string; text: string; submitLike: boolean; isPassword: boolean; disabled: boolean }
interface ObservationRecord { obsId: string; at: number; elements: Map<number, ElementInfo> }

const observations = new WeakMap<object, ObservationRecord>();
const identity = (page: Page): object => (typeof page.mainFrame === 'function' ? page.mainFrame() : page);
let seq = 0;
const newObsId = () => `o${Date.now().toString(36)}${(seq++).toString(36)}`;

export type Hint = 'login' | 'captcha' | 'risk' | 'submit_page';
/** 页面上需要本人处理的迹象（纯函数）。 */
export function detectHints(raw: Pick<RawObservation, 'hasPassword' | 'bodySample' | 'url'>, elements: ElementInfo[]): Hint[] {
  const hints = new Set<Hint>();
  const t = raw.bodySample;
  if (raw.hasPassword || /扫码登录|微信登录|请先登录|登录后查看|手机号登录|验证码登录/.test(t)) hints.add('login');
  if (/滑块|拖动滑块|安全验证|人机验证|请完成验证|协助验证|不是自动程序|captcha|geetest|验证码已发送/i.test(t)) hints.add('captcha');
  if (/访问过于频繁|操作频繁|异常访问|风险提示|账号存在异常|请求存在异常|限制本次访问|操作存在异常|暂停您的访问|访问被阻断|访问受限/.test(t) || VERIFICATION_URL_RX.test(raw.url)) hints.add('risk');
  if (elements.some(e => e.submitLike)) hints.add('submit_page');
  return [...hints];
}

export interface Observation {
  observation_id: string; url: string; title: string;
  scroll: { y: number; max: number; viewport: number };
  elements: Array<{ ref: number; kind: string; text: string; href?: string; value?: string; checked?: boolean; options?: string[]; disabled?: boolean; offscreen?: boolean; guarded?: 'submit' | 'password' }>;
  more_elements: number;
  text: string; text_total: number;
  hints: Hint[];
  tabs: Array<{ index: number; title: string; url: string; active: boolean }>;
}

export interface BrowseDeps {
  isSubmitText: (text: string) => boolean;
  /** {{vault:...}} → 明文（只在 Node 侧，写访问日志）。 */
  resolveVault?: (text: string) => string;
  /** 占位符检测：密码框只接受占位符。 */
  hasPlaceholder?: (text: string) => boolean;
  /** 同站拟人停顿（毫秒）。 */
  pacingMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  settleMs?: number;
}

const lastActionAt = new Map<string, number>();
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };

async function tabsOf(context: BrowserContext, current: Page): Promise<Observation['tabs']> {
  const pages = context.pages().filter(p => !p.isClosed());
  return Promise.all(pages.map(async (p, index) => ({ index, title: (await p.title().catch(() => '')).slice(0, 60), url: p.url().slice(0, 200), active: identity(p) === identity(current) })));
}

export async function observe(context: BrowserContext, page: Page, deps: BrowseDeps, opts: { max?: number; textMax?: number } = {}): Promise<Observation> {
  const obsId = newObsId();
  const raw = await inPage(page, observeInPage, { obsId, max: opts.max ?? 80 });
  const body = await inPage(page, readInPage, { offset: 0, length: opts.textMax ?? 1500 });
  const infos = new Map<number, ElementInfo>();
  const elements: Observation['elements'] = raw.elements.map(e => {
    const clickable = e.kind === 'button' || e.kind === 'link' || e.kind === 'clickable' || e.kind === 'menuitem' || e.kind === 'tab';
    const submitLike = clickable && deps.isSubmitText(e.text);
    infos.set(e.ref, { kind: e.kind, text: e.text, submitLike, isPassword: !!e.isPassword, disabled: !!e.disabled });
    return {
      ref: e.ref, kind: e.kind, text: e.text,
      ...(e.href ? { href: e.href } : {}), ...(e.value ? { value: e.value } : {}), ...(e.checked !== undefined ? { checked: e.checked } : {}),
      ...(e.options?.length ? { options: e.options } : {}), ...(e.disabled ? { disabled: true } : {}), ...(!e.inViewport ? { offscreen: true } : {}),
      ...(submitLike ? { guarded: 'submit' as const } : e.isPassword ? { guarded: 'password' as const } : {}),
    };
  });
  observations.set(identity(page), { obsId, at: Date.now(), elements: infos });
  return {
    observation_id: obsId, url: raw.url, title: raw.title,
    scroll: { y: raw.scrollY, max: raw.scrollMax, viewport: raw.viewportH },
    elements, more_elements: Math.max(0, raw.total - raw.elements.length),
    text: body.text, text_total: body.total,
    hints: detectHints(raw, [...infos.values()]),
    tabs: await tabsOf(context, page),
  };
}

export type ActAction = 'click' | 'type' | 'select' | 'check' | 'press' | 'scroll' | 'back' | 'forward' | 'navigate' | 'switch_tab' | 'close_tab' | 'wait' | 'click_at' | 'drag';
export interface ActRequest { observation_id?: string; ref?: number; action: ActAction; text?: string; option?: string; key?: string; direction?: 'up' | 'down'; url?: string; tab?: number; ms?: number; submit?: boolean;
  /** click_at / drag 的视口坐标（像素）；drag 拖到 to_x / to_y。 */
  x?: number; y?: number; to_x?: number; to_y?: number }
export interface Receipt {
  ok: boolean; action: ActAction;
  observed_effect: 'navigated' | 'changed' | 'no_change' | 'unknown';
  url_before: string; url_after: string;
  new_tabs: Array<{ title: string; url: string }>;
  /** 操作后要看的那一页（新开标签时会切过去）。 */
  page: Page;
  retryable: boolean;
  required_next: 'observe' | 'none' | 'handoff' | 'apply_flow' | 'retry_or_observe';
  code?: 'stale_observation' | 'element_gone' | 'blocked_by_overlay' | 'submit_guarded' | 'password_needs_placeholder' | 'disabled' | 'bad_request' | 'navigation_timeout' | 'navigation_failed' | 'dispatch_failed';
  note: string;
}

const refuse = (page: Page, action: ActAction, code: Receipt['code'], note: string, required_next: Receipt['required_next'] = 'observe'): Receipt => ({
  ok: false, action, observed_effect: 'no_change', url_before: page.url(), url_after: page.url(), new_tabs: [], page, retryable: required_next === 'observe', required_next, code, note,
});

/** 坐标操作的参数和闸：坐标下面是提交类按钮就不点（专门的验证页除外）。 */
async function checkPointer(page: Page, req: ActRequest, deps: BrowseDeps): Promise<Receipt | null> {
  if (req.action !== 'click_at' && req.action !== 'drag') return null;
  const nums = req.action === 'drag' ? [req.x, req.y, req.to_x, req.to_y] : [req.x, req.y];
  if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) return refuse(page, req.action, 'bad_request', `${req.action} 需要坐标 x / y${req.action === 'drag' ? ' / to_x / to_y' : ''}（视口像素）`);
  if (req.action === 'drag') return null;
  const target = await inPage(page, pointTargetInPage, { x: req.x!, y: req.y! });
  if (target && deps.isSubmitText(target.text) && !VERIFICATION_URL_RX.test(page.url())) {
    return refuse(page, req.action, 'submit_guarded', `坐标 (${req.x}, ${req.y}) 下面是「${target.text}」，是提交 / 投递类按钮，助理不能点。`, 'apply_flow');
  }
  return null;
}

export async function act(context: BrowserContext, page: Page, req: ActRequest, deps: BrowseDeps): Promise<Receipt> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const needsRef = ['click', 'type', 'select', 'check'].includes(req.action);
  const record = observations.get(identity(page));
  let info: ElementInfo | undefined;
  if (needsRef) {
    if (!req.observation_id || req.ref == null) return refuse(page, req.action, 'bad_request', '这个操作要带 observation_id 和 ref（先 browser_observe）');
    if (!record || record.obsId !== req.observation_id) return refuse(page, req.action, 'stale_observation', '观察编号已过期：页面在那之后变过（或换了标签页）。先 browser_observe 再操作，不要沿用旧编号。');
    info = record.elements.get(req.ref);
    if (!info) return refuse(page, req.action, 'element_gone', `这次观察里没有编号 ${req.ref} 的元素，先 browser_observe 重新看。`);
    if (info.disabled) return refuse(page, req.action, 'disabled', `「${info.text}」当前不可点击。`, 'observe');
    if (req.action === 'click' && info.submitLike && !VERIFICATION_URL_RX.test(page.url())) {
      return refuse(page, req.action, 'submit_guarded', `「${info.text}」是提交 / 投递类按钮，助理不能直接点。要投递：先 browser_capture_job 收录这个岗位，再 apply_prepare 让用户批准，由投递流程处理（入口页会交给用户点进去）。`, 'apply_flow');
    }
    if (req.action === 'type' && info.isPassword && !(deps.hasPlaceholder?.(req.text ?? '') ?? false)) {
      return refuse(page, req.action, 'password_needs_placeholder', '密码框只能填私密信息库里的占位符（{{vault:site.<网站>.password}}），不能填明文。没有存的话请用户在现场自己登录。', 'handoff');
    }
  }
  if (req.action === 'type' && typeof req.text !== 'string') return refuse(page, req.action, 'bad_request', 'type 需要 text');
  const pointerRefusal = await checkPointer(page, req, deps);
  if (pointerRefusal) return pointerRefusal;
  if (req.action === 'navigate' && !/^https?:\/\//i.test(req.url ?? '')) return refuse(page, req.action, 'bad_request', 'navigate 需要 http(s) 网址');

  // 同站拟人停顿
  const host = hostOf(page.url());
  const [lo, hi] = deps.pacingMs ?? [700, 1500];
  const last = lastActionAt.get(host) ?? 0;
  const gap = lo + Math.random() * (hi - lo);
  if (host && now() - last < gap) await sleep(gap - (now() - last));

  const urlBefore = page.url();
  const sigBefore = await inPage(page, signatureInPage, null).catch(() => '');
  const opened: Page[] = [];
  const onPage = (p: Page) => { opened.push(p); };
  context.on('page', onPage);
  let target = page;
  let dispatchError: unknown = null;
  try {
    const el = needsRef ? page.locator(`[data-ks-ref="${req.observation_id}:${req.ref}"]`).first() : null;
    switch (req.action) {
      case 'click': await el!.click({ timeout: 5000 }); break;
      case 'type': {
        const value = deps.resolveVault ? deps.resolveVault(req.text!) : req.text!;
        await el!.fill(value, { timeout: 5000 });
        if (req.submit) await el!.press('Enter');
        break;
      }
      case 'select': await el!.selectOption({ label: req.option ?? '' }, { timeout: 5000 }); break;
      case 'check': await el!.check({ timeout: 5000 }); break;
      case 'press': await page.keyboard.press(req.key ?? 'Enter'); break;
      case 'scroll': await inPage(page, scrollInPage, req.direction ?? 'down'); break;
      case 'back': await page.goBack({ timeout: 10_000 }).catch(() => null); break;
      case 'forward': await page.goForward({ timeout: 10_000 }).catch(() => null); break;
      case 'navigate': await navigateWithRetry(page, req.url!); break;
      case 'switch_tab': case 'close_tab': {
        const pages = context.pages().filter(p => !p.isClosed());
        const p = pages[req.tab ?? -1];
        if (!p) return refuse(page, req.action, 'bad_request', `没有第 ${req.tab} 个标签页`);
        if (req.action === 'close_tab') {
          if (pages.length <= 1) return refuse(page, req.action, 'bad_request', '只剩一个标签页，不能关');
          await p.close();
          target = pages.find(x => x !== p && !x.isClosed()) ?? page;
        } else target = p;
        break;
      }
      case 'wait': await sleep(Math.min(Math.max(req.ms ?? 1000, 0), 5000)); break;
      case 'click_at': await page.mouse.click(req.x!, req.y!, { delay: 40 + Math.random() * 80 }); break;
      case 'drag': await humanDrag(page, { x: req.x!, y: req.y! }, { x: req.to_x!, y: req.to_y! }, sleep); break;
    }
  } catch (error) {
    dispatchError = error;
  }
  // 等页面稳定（跳转 / 渲染），再判效果
  await target.waitForLoadState('domcontentloaded', { timeout: NAV_SETTLE_TIMEOUT_MS }).catch(() => {});
  await sleep(deps.settleMs ?? 600);
  context.off('page', onPage);
  lastActionAt.set(host, now());
  const fresh = opened.filter(p => !p.isClosed());
  if (fresh.length && req.action !== 'switch_tab' && req.action !== 'close_tab') target = fresh[fresh.length - 1];
  if (!dispatchError && (req.action === 'navigate' || target !== page || target.url() !== urlBefore)) {
    await waitForRender(target, sleep).catch(error => console.warn(`[browse] render-wait failed url=${target.url().slice(0, 120)}: ${String(error).slice(0, 160)}`));
  }
  const newTabs = await Promise.all(fresh.map(async p => ({ title: (await p.title().catch(() => '')).slice(0, 60), url: p.url().slice(0, 200) })));
  const urlAfter = target.url();
  const sigAfter = await inPage(target, signatureInPage, null).catch(() => '');
  if (dispatchError) {
    const msg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
    const changedAnyway = urlAfter !== urlBefore || (sigAfter && sigAfter !== sigBefore);
    if (req.action === 'navigate') {
      // 导航无副作用：失败就该重试，而不是让模型放弃转告用户"打不开"
      return {
        ok: false, action: req.action, observed_effect: changedAnyway ? 'changed' : 'unknown', url_before: urlBefore, url_after: urlAfter, new_tabs: newTabs, page: target,
        retryable: true, required_next: changedAnyway ? 'observe' : 'retry_or_observe', code: /timeout/i.test(msg) ? 'navigation_timeout' : 'navigation_failed',
        note: changedAnyway
          ? `导航报错但地址栏已变化，页面可能其实打开了：先 browser_observe 确认再决定是否重试。${msg.slice(0, 120)}`
          : `${msg.slice(0, 200)} 导航可以再试一次；两次都失败先用 browser_observe 看当前页，再按错误指引处理，不要直接跟用户说打不开。`,
      };
    }
    // 点击根本没发出去：被弹层挡住（引导遮罩、登录弹窗、Cookie 横幅）。实测字节校招的「AI 助手引导」遮罩挡住全部岗位链接
    const overlay = changedAnyway ? undefined : msg.split('\n').find(l => l.includes('intercepts pointer events'));
    if (overlay) {
      return {
        ok: false, action: req.action, observed_effect: 'no_change', url_before: urlBefore, url_after: urlAfter, new_tabs: newTabs, page: target,
        retryable: true, required_next: 'observe', code: 'blocked_by_overlay',
        note: `点击没有发出去：被页面上的弹层挡住了（${overlay.replaceAll(ANSI_ESC, '').replace(/\[\d+m/g, '').trim().slice(0, 120)}）。先 browser_observe，在元素里找「关闭 / 我知道了 / 跳过 / ×」之类关掉弹层，或按 Escape，再点原来的元素。`,
      };
    }
    // 发出去但没确认（超时等）：效果不明，禁止重放
    return {
      ok: false, action: req.action, observed_effect: changedAnyway ? 'changed' : 'unknown', url_before: urlBefore, url_after: urlAfter, new_tabs: newTabs, page: target,
      retryable: false, required_next: 'observe', code: /timeout/i.test(msg) ? 'navigation_timeout' : 'dispatch_failed',
      note: `操作没有确认成功（${msg.slice(0, 120)}）。不要重复同一个操作，先 browser_observe 看看页面现在是什么样。`,
    };
  }
  const effect: Receipt['observed_effect'] = urlAfter !== urlBefore || target !== page ? 'navigated' : sigAfter !== sigBefore ? 'changed' : 'no_change';
  if (effect !== 'no_change' || target !== page) observations.delete(identity(page));
  return {
    ok: true, action: req.action, observed_effect: effect, url_before: urlBefore, url_after: urlAfter, new_tabs: newTabs, page: target,
    retryable: effect === 'no_change', required_next: 'observe',
    note: effect === 'no_change'
      ? (req.action === 'scroll' ? '已滚动。' : '页面没有明显变化：可能需要等加载，或者点到的不是你想要的元素。先 browser_observe 确认，不要连点。')
      : fresh.length ? `打开了新标签页「${newTabs[newTabs.length - 1].title}」，已切过去。` : effect === 'navigated' ? '已跳转。' : '页面有变化。',
  };
}

const plainSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 网络空闲最多等这么久：长连接 / 轮询的站点永远等不到空闲。 */
const RENDER_IDLE_MAX_MS = 3000;
const RENDER_POLL_MS = 400;
const RENDER_STABLE_MAX_POLLS = 5;

function bodyLengthInPage(): number { return document.body ? document.body.innerText.length : 0; }

/**
 * 新文档到了以后，等单页应用把接口数据渲染出来再观察：列表常在 domcontentloaded 后 1～3 秒才出现
 * （实测字节校招列表，无头 +0.6s 正文 187 字、+2.5s 5669 字）。先等网络空闲（有上限），再等正文字数连续两次不变。
 */
async function waitForRender(page: Page, sleep: (ms: number) => Promise<void>): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: RENDER_IDLE_MAX_MS }).catch(() => { /* 等不到空闲按上限放行，下面还会看正文是否稳定 */ });
  let last = -1;
  for (let i = 0; i < RENDER_STABLE_MAX_POLLS; i++) {
    const len = await inPage(page, bodyLengthInPage, null);
    if (len === last) return;
    last = len;
    await sleep(RENDER_POLL_MS);
  }
}

/**
 * 导航一次超时不判死：慢站（北森 / 海外 ATS）首次加载超 20 秒很常见，超时也常常发生在
 * domcontentloaded 之后的 load 阶段（页面其实已经到了）。策略：
 * 1) 第一次 20s domcontentloaded；失败先看地址栏是否已到达目标（忽略 hash / 末尾斜杠）；
 * 2) 未到达 → 稍等后第二次 45s；
 * 3) 两次都失败才抛错，错误按类型带上给模型的行动指引（导航无副作用，鼓励重试）。
 */
export async function navigateWithRetry(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
    return;
  } catch {
    if (sameNavigationTarget(page.url(), url)) return; // 已到达：超时只是发生在 load 阶段
    await plainSleep(1_500);
  }
  try {
    await page.goto(url, { timeout: 45_000, waitUntil: 'domcontentloaded' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(msg)) {
      throw new Error(`导航两次尝试均超时（站点加载很慢）：先用 browser_observe 看当前页——可能已部分打开可直接继续；否则稍后再 navigate 一次；多次失败应询问用户该站是否可访问或需要网络/代理。原文错误：${msg.slice(0, 160)}`);
    }
    if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NAME_RESOLUTION_FAILED/i.test(msg)) {
      throw new Error(`导航失败（网络层错误，多为链接本身或网络问题）：${msg.slice(0, 160)}。核对链接拼写；确认用户网络可访问该站（部分内网 / 校园网站需要对应网络）；可稍后再试一次。`);
    }
    throw new Error(`导航失败：${msg.slice(0, 160)}。导航本身无副作用，可以再试一次；连续失败用 browser_observe 看当前页，并把这个错误原样告诉用户。`);
  }
}

/** 比较地址栏与目标是否同一页面（忽略 hash、末尾斜杠、协议大小写；目标片段视为已到达）。 */
function sameNavigationTarget(current: string, target: string): boolean {
  try {
    const c = new URL(current), t = new URL(target);
    const norm = (u: URL) => `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
    return norm(c) === norm(t) || current.startsWith(target.split('#')[0]);
  } catch {
    return current === target;
  }
}

export async function read(page: Page, offset = 0, length = 4000): Promise<{ text: string; offset: number; total: number; next_offset: number | null; url: string; title: string }> {
  const r = await inPage(page, readInPage, { offset, length });
  return { text: r.text, offset, total: r.total, next_offset: offset + length < r.total ? offset + length : null, url: page.url(), title: await page.title().catch(() => '') };
}

/** 仅测试用。 */
export function resetBrowseState(): void { lastActionAt.clear(); }
