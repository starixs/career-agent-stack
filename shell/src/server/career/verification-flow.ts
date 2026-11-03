import { setTimeout as delay } from 'node:timers/promises';

import type { VerificationTemplate } from './verification-config';
import type { OtpPage } from './verification-page';
import type { PreparedCode } from './verification-source';

export type VerificationStatus = 'unchanged' | 'changed' | 'needs_user';
export interface OtpFlowDeps {
  page: OtpPage; template: VerificationTemplate; recipient: string; signal: AbortSignal;
  prepare(): Promise<PreparedCode>;
  solveCaptcha(): Promise<'none' | 'changed' | 'needs_user'>;
  /** 一张页面同一模板只允许发送一次，超时不会自动重发。 */
  claimSend(): boolean;
  assertActive(): void;
  progress(message: string): void;
  now?: () => number;
  sleep?: () => Promise<void>;
}
const SUCCESS_POLL_MS = 500;
const MAX_SUCCESS_POLLS = 20;

async function success(deps: OtpFlowDeps): Promise<boolean> {
  for (let i = 0; i < MAX_SUCCESS_POLLS; i++) {
    deps.assertActive(); deps.signal.throwIfAborted();
    if (await deps.page.visible(deps.template.successSelector)) return true;
    await (deps.sleep?.() ?? delay(SUCCESS_POLL_MS, undefined, { signal: deps.signal }));
  }
  return false;
}

/** 普通收码流程，不猜站点、不点申请提交、不把「填入了」当成「通过了」。 */
export async function runOtpFlow(deps: OtpFlowDeps): Promise<VerificationStatus> {
  const { page, template: t, signal } = deps;
  deps.assertActive(); signal.throwIfAborted();
  if (await page.visible(t.successSelector)) return 'unchanged';
  if (!(await page.visible(t.recipientSelector)) || !(await page.visible(t.sendSelector))) return 'needs_user';
  if (await deps.solveCaptcha() === 'needs_user') return 'needs_user';
  await page.recipient(t.recipientSelector, deps.recipient);
  const source = await deps.prepare();
  try {
    deps.assertActive(); signal.throwIfAborted();
    if (!deps.claimSend()) return 'needs_user';
    const since = (deps.now ?? Date.now)();
    deps.progress(t.channel === 'sms' ? '正在获取短信验证码' : '正在获取邮箱验证码');
    await page.click(t.sendSelector, 'send');
    if (await deps.solveCaptcha() === 'needs_user') return 'needs_user';
    const code = await source.wait(since);
    deps.assertActive(); signal.throwIfAborted();
    if (!code) return 'needs_user';
    await page.code(t.codeSelectors, code);
    if (t.confirmSelector) await page.click(t.confirmSelector, 'confirm');
    if (await deps.solveCaptcha() === 'needs_user') return 'needs_user';
    if (!(await success(deps))) return 'needs_user';
    deps.progress('验证已通过，继续填写');
    return 'changed';
  } finally { await source.close(); }
}
