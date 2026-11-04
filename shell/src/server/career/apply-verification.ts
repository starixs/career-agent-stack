import type { LLM, Repos } from '@career/core';
import type { VerificationHandler } from '@career/apply';
import type { Page } from 'playwright';
import { z } from 'zod';

import { autoCaptcha } from './captcha-automation';
import { captchaPageFromPlaywright } from './captcha-page-adapter';
import { getRepos } from './db';
import { loadVerificationConfig, templateFor, type VerificationConfig } from './verification-config';
import { runOtpFlow } from './verification-flow';
import { otpPage } from './verification-page';
import { acquireCodeLease, prepareCodeSource } from './verification-source';

const attempts = new WeakMap<object, Set<string>>();
/** 一次 drive 最多三轮图形验证（发码前、发码后、登录后），不因重读无限循环。 */
const MAX_CAPTCHA_ROUNDS = 3;
const CONTROL_POLL_MS = 250;
interface Dependencies {
  page: Page; llm: LLM; profile: Record<string, unknown>; signal: AbortSignal;
  resolveValue?: (v: string) => string;
  batch?: boolean;
  assertActive(): void;
  progress(message: string): void;
}
const basicsSchema = z.object({ phone: z.string().optional(), email: z.string().optional() }).passthrough();
interface Context { deps: Dependencies; config: VerificationConfig; repos: Repos; basics: z.infer<typeof basicsSchema>; sent: Set<string>; captchaRounds: number }

async function hasUnmanagedCode(page: Page): Promise<boolean> {
  return await page.evaluate(() => Array.from(document.querySelectorAll('input')).some(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.dataset.careerPrivate !== 'otp'
      && (el.autocomplete === 'one-time-code' || /验证码|sms.?code|email.?code|verification.?code|otp/i.test(`${el.name} ${el.placeholder}`));
  })) === true;
}

function assertActive(ctx: Context, signal: AbortSignal): void {
  signal.throwIfAborted(); ctx.deps.assertActive();
  if (ctx.deps.page.isClosed()) throw new Error('页面已关闭');
  const state = ctx.deps.batch ? ctx.repos.kvGet<{ status: string }>('apply:batch:state') : undefined;
  if (state && state.status !== 'running') throw new Error('批量已暂停或停止');
}

async function verifyOnce(ctx: Context, signal: AbortSignal): Promise<Awaited<ReturnType<VerificationHandler>>> {
  const { deps, config, repos, basics, sent } = ctx;
  const active = () => assertActive(ctx, signal);
  const solve = async () => {
    active();
    if (!config.captcha) return 'none' as const;
    const result = await autoCaptcha(captchaPageFromPlaywright(deps.page), deps.llm, active, ctx.captchaRounds < MAX_CAPTCHA_ROUNDS);
    if (result !== 'none') ctx.captchaRounds++;
    return result;
  };
  active();
  const t = templateFor(config, deps.page.url());
  if (!t) {
    const result = await solve();
    if (result !== 'none') return { status: result };
    return { status: await hasUnmanagedCode(deps.page) ? 'needs_user' : 'unchanged' };
  }
  const raw = basics[t.channel === 'sms' ? 'phone' : 'email'];
  const recipient = raw && (deps.resolveValue?.(raw) ?? raw).trim();
  if (!recipient || recipient.includes('{{vault:')) return { status: 'needs_user' };
  const release = await acquireCodeLease(t.channel === 'sms' ? 'sms' : `email:${recipient.toLowerCase()}`, signal);
  try {
    const status = await runOtpFlow({
      page: otpPage(deps.page, t, active), template: t, recipient, signal,
      prepare: () => prepareCodeSource(repos, t, recipient, signal), solveCaptcha: solve,
      claimSend: () => { if (sent.has(t.id)) return false; sent.add(t.id); return true; },
      assertActive: active, progress: deps.progress,
    });
    return { status };
  } finally { release(); }
}

/** Global drive/approved-submit 路由组合；配置不开放给模型工具覆盖。 */
export async function createApplyVerification(deps: Dependencies): Promise<VerificationHandler | undefined> {
  const config = await loadVerificationConfig();
  if (!config.enabled) return undefined;
  const identity = deps.page.mainFrame();
  const sent = attempts.get(identity) ?? new Set<string>();
  attempts.set(identity, sent);
  const ctx: Context = { deps, config, repos: await getRepos(), basics: basicsSchema.parse(deps.profile.basics ?? {}), sent, captchaRounds: 0 };
  return async () => {
    const controller = new AbortController();
    const signal = AbortSignal.any([deps.signal, controller.signal, AbortSignal.timeout(config.timeoutMs)]);
    const timer = setInterval(() => { try { assertActive(ctx, signal); } catch { controller.abort(); } }, CONTROL_POLL_MS);
    try { return await verifyOnce(ctx, signal); } catch {
      console.warn('[apply-verification] incomplete; user takeover required');
      return { status: 'needs_user' };
    } finally { clearInterval(timer); controller.abort(); }
  };
}
