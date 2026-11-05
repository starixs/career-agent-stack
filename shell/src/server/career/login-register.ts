/**
 * 登录之旅里的自动注册（2026-11-03 用户：「有的需要注册，你可以全自动完成的就全自动完成」，例：中国中车只给扫码、可换邮箱注册）：
 * 这家没有短信登录、他也还没有这个站的账号 → 用资料里的邮箱：能邮箱验证码登录（首次登录自动建号）就收码登录，
 * 只能注册就生成一个站点密码去注册；码都从他连着的邮箱里读。注册成了把账号密码存进私密库（这个站），以后登录直接代填。
 * 邮箱没连上：如实报，不硬来。网站要拼图：请他在画面上拖，拖好后码照样从邮箱自己取。
 */
import { randomInt } from 'node:crypto';

import type { Repos } from '@career/core';
import type { Page } from 'playwright';

import type { SmsState } from './login-journey';
import { openLoginCodeSource } from './login-code-source';
import { MAIL_CODE_TIMEOUT_MS, mailboxFor, waitForMailCode } from './mail/code';
import { loadApplyModule } from '../routes/career-browser';
import { logSlowCalls } from './slow-calls';

/** 站点密码：多数网申站要 8-20 位、字母加数字；12 位、去掉易混的 0/O/1/l/I。 */
const SITE_PASSWORD_LENGTH = 12;
const LETTERS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

export function generateSitePassword(): string {
  const pool = LETTERS + DIGITS;
  const chars = [LETTERS[randomInt(LETTERS.length)], DIGITS[randomInt(DIGITS.length)]];
  while (chars.length < SITE_PASSWORD_LENGTH) chars.push(pool[randomInt(pool.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

export const hostOf = (url: string): string | null => { try { return new URL(url).hostname; } catch { return null; } };

/** 他的邮箱（私密库）和对应的已连邮箱；有一样缺就不代办注册。 */
async function ownMailbox(repos: Repos) {
  const { getVault } = await import('./vault');
  const vault = await getVault();
  const email = vault.profileBasics({ actor: 'login_fill', purpose: '邮箱注册' }).email?.trim();
  return { vault, email, mailbox: email ? mailboxFor(repos, email) : null };
}

/** 他看图打字最多等多久：和登录之旅一家的时限一样。 */
const IMAGE_ANSWER_TIMEOUT_MS = 180_000;
/** 收码点登录后等「首次登录 · 设置密码」框弹出来。 */
const FIRST_PASSWORD_WAIT_MS = 2_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** 打错了网站换一张，最多给他看这么多张。 */
const IMAGE_TRIES = 3;

/** 正在等他看图打字的那一页：他从那一格报上来的字交到这里。 */
const imageAnswers = new WeakMap<Page, (text: string) => void>();
export function answerPendingImage(page: Page, text: string): boolean {
  const resolve = imageAnswers.get(page);
  if (!resolve) return false;
  imageAnswers.delete(page);
  resolve(text);
  return true;
}
/** 他直接在网页上答了（不经产品那一格）。 */
const ANSWERED_ON_PAGE = Symbol('answered-on-page');
/** 多久看一眼网页上那张图还在不在。 */
const PAGE_ANSWER_POLL_MS = 1_000;

/** 等他答图形码：产品那一格报上来的字，或者他直接在网页上答完（图不见了，2026-11-03 中国中车），哪个先到算哪个。 */
function waitImageAnswer(page: Page, gone?: () => Promise<boolean>): Promise<string | typeof ANSWERED_ON_PAGE | null> {
  return new Promise(resolve => {
    let poll: ReturnType<typeof setInterval> | undefined;
    const done = (v: string | typeof ANSWERED_ON_PAGE | null) => { clearTimeout(timer); if (poll) clearInterval(poll); imageAnswers.delete(page); resolve(v); };
    const timer = setTimeout(() => done(null), IMAGE_ANSWER_TIMEOUT_MS);
    imageAnswers.set(page, text => done(text));
    if (gone) poll = setInterval(() => {
      gone().then(g => { if (g) done(ANSWERED_ON_PAGE); }, (e: unknown) => console.warn('[career] login-register: 看不了网页上的图形码', e instanceof Error ? e.message : e));
    }, PAGE_ANSWER_POLL_MS);
  });
}

/** 他点了产品里那张图：替他在网站上换一张。 */
export async function refreshPendingImage(page: Page): Promise<string | null> {
  const apply = await loadApplyModule();
  if (!apply?.refreshImageCode) return null;
  return (await apply.refreshImageCode(apply.fromPlaywright(page))) ?? null;
}

export type Apply = NonNullable<Awaited<ReturnType<typeof loadApplyModule>>>;
/** 他打的字填回去之后：ok 往下走；again 网站换了一张（打错了）；或者一个要直接报的状态。 */
export type ImageAnswerOutcome = 'ok' | 'again' | SmsState;

/** 图形码：把图给他看、等他打字、交给 answer 填回去；打错了换一张再给他看。过了返回 null，否则返回要报的状态。 */
export async function passImageCode(apply: Apply, page: Page, report: (s: SmsState) => void, answer: (text: string) => Promise<ImageAnswerOutcome>): Promise<SmsState | null> {
  if (!apply.imageCodeDataUrl) return { status: 'no_sms', detail: '投递引擎版本不支持图形码' };
  const P = logSlowCalls(apply.fromPlaywright(page), 'register');
  for (let i = 0; i < IMAGE_TRIES; i++) {
    const image = await apply.imageCodeDataUrl(P);
    report({ status: 'image_code', ...(image ? { image } : {}), ...(i ? { detail: '上一张没对上，换了一张' } : {}) });
    const gone = apply.imageCodeGone;
    const text = await waitImageAnswer(page, gone ? () => gone(P) : undefined);
    if (!text) return { status: 'no_sms', detail: '图形码没等到你填' };
    if (text === ANSWERED_ON_PAGE) { console.log('[career] login-register: 他在网页上答了图形码，接着往下办'); return null; }
    const r = await answer(text);
    if (r === 'ok') return null;
    if (r !== 'again') return r;
  }
  return { status: 'no_sms', detail: '图形码连着几次没对上' };
}

/** 邮箱验证码那条路的图形码：填回去点「确认发送」，看发没发出去。 */
async function answerForMailCode(apply: Apply, page: Page, text: string): Promise<ImageAnswerOutcome> {
  if (!apply.answerImageCode) return { status: 'no_sms', detail: '投递引擎版本不支持图形码' };
  const r = await apply.answerImageCode(apply.fromPlaywright(page), text);
  if (r.status === 'sent') return 'ok';
  if (r.status === 'image_code') return 'again';
  if (r.status === 'captcha') return { status: 'captcha', detail: r.evidence };
  // 页面上一时没看到倒计时（2026-11-03 中国中车：其实已经发了，「59s」晚一点才出来）：照样去邮箱等，等不到再如实说
  console.log('[career] login-register: 填了图形码，页面上没看到倒计时，照样去邮箱等验证码');
  return 'ok';
}

export function saveSiteAccount(vault: Awaited<ReturnType<typeof ownMailbox>>['vault'], host: string, email: string, password: string): void {
  vault.set({ scope: 'site', ref_id: host, field: 'username', value: email, policy: { autofill: true } });
  vault.set({ scope: 'site', ref_id: host, field: 'password', value: password, sensitive: true, policy: { autofill: true } });
}

/**
 * 邮件里的验证码怎么等：这家配了模板就用配好的来源（点发码之前就开、只认模板发件人），否则用通用取码。
 * 用完调 close。
 */
async function mailCodeWaiter(repos: Repos, page: Page, mailbox: NonNullable<ReturnType<typeof mailboxFor>>, email: string): Promise<{ wait(since: number, timeoutMs: number): Promise<string | null>; close(): Promise<void> }> {
  const configured = await openLoginCodeSource(repos, page.url(), 'email', email);
  if (configured) return configured;
  return { wait: (since, timeoutMs) => waitForMailCode(mailbox, since, { timeoutMs }), close: async () => undefined };
}

/** 返回 null 表示这家不走注册（没有注册表单 / 已有账号 / 引擎不支持），由调用方照原样报。 */
export async function autoRegisterByEmail(repos: Repos, page: Page, report: (s: SmsState) => void): Promise<SmsState | null> {
  const host = hostOf(page.url());
  const apply = await loadApplyModule();
  if (!host || !apply?.prepareEmailRegister || !apply.submitRegisterCode) return null;
  const { vault, email, mailbox } = await ownMailbox(repos);
  if (!email) return null;
  if (!mailbox) { console.log(`[career] login-register ${host}: 邮箱还没连上，走手机号`); return null; } // 邮箱没连：让手机短信那条路接着试
  const password = generateSitePassword();
  const P = logSlowCalls(apply.fromPlaywright(page), 'register');
  const codes = await mailCodeWaiter(repos, page, mailbox, email);
  try { return await registerWithMail({ apply, P, page, report, codes, host, email, password, vault }); } finally { await codes.close(); }
}

interface MailRegister {
  apply: Apply; P: ReturnType<Apply['fromPlaywright']>; page: Page; report: (s: SmsState) => void;
  codes: Awaited<ReturnType<typeof mailCodeWaiter>>; host: string; email: string; password: string;
  vault: Awaited<ReturnType<typeof ownMailbox>>['vault'];
}

async function registerWithMail({ apply, P, page, report, codes, host, email, password, vault }: MailRegister): Promise<SmsState | null> {
  if (!apply.prepareEmailRegister || !apply.submitRegisterCode) return null;
  const since = Date.now();
  // 已经登上、只差「首次登录 · 设置密码」（上次收码登上后框没处理完）：设上就算办完
  if (await apply.setFirstPassword?.(P, password)) { saveSiteAccount(vault, host, email, password); return { status: 'registered' }; }
  // 上一趟点过「获取验证码」、图形码还挂在页面上（2026-11-03 中国中车：那一行只剩「确认发送」，找不到「获取验证码」就判成没表单）：直接请他看图
  const pending = await apply.findImageCode?.(P);
  const r = pending ? { status: 'image_code' as const, withPassword: false } : await apply.prepareEmailRegister(P, { email, password });
  if (r.status === 'no_register') { console.log(`[career] login-register ${host}: ${r.reason}`); return null; }
  const withPassword = r.status !== 'captcha' && r.withPassword;
  let code: string | null;
  if (r.status === 'captcha') {
    // 点「获取验证码」弹了拼图（2026-11-03 畅游 / Moka）：拼图要他本人拖；拖好码就发到邮箱，照样自己去取，不让他填
    report({ status: 'mail_captcha' });
    code = await codes.wait(since, IMAGE_ANSWER_TIMEOUT_MS);
    if (!code) return { status: 'no_sms', detail: '拼图之后三分钟没等到验证码邮件' };
  } else {
    if (r.status === 'image_code') { const stuck = await passImageCode(apply, page, report, text => answerForMailCode(apply, page, text)); if (stuck) return stuck; }
    report({ status: 'registering', detail: r.status === 'image_code' ? `图上的字对了，验证码已经发到 ${email}，正在取` : `验证码已经发到 ${email}，正在取` });
    code = await codes.wait(since, MAIL_CODE_TIMEOUT_MS);
    if (!code) return { status: 'no_sms', detail: '验证码邮件两分钟没到' };
  }
  report({ status: 'registering', detail: '从邮箱取到验证码了，正在登录' });
  const done = await apply.submitRegisterCode(P, code);
  if (!done.ok) return { status: 'no_sms', detail: done.reason ?? '验证码没填上' };
  // 收码登上后网站还要「首次登录 · 设置密码」（中国中车）：用生成的密码设上，当成注册了
  await sleep(FIRST_PASSWORD_WAIT_MS);
  const setPassword = !withPassword && !!(await apply.setFirstPassword?.(P, password));
  // 邮箱验证码登录（首次登录自动建号）没有密码：下次照样用邮箱收码登，不存密码
  if (withPassword || setPassword) saveSiteAccount(vault, host, email, password);
  console.log(`[career] login-register ${host}: 用邮箱${withPassword || setPassword ? '注册完成，账号已存进私密库' : '验证码登录'}`);
  return { status: 'registered' };
}
