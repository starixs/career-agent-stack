import type { LLM } from '@career/core';
import type { CaptchaPage, CaptchaPolicy } from '@career/captcha';

let policyPromise: Promise<CaptchaPolicy> | null = null;
const inFlight = new Set<string>();
/** 对话工具与网申共用预算，不能换入口重置连败冷却。 */
export function getCaptchaPolicy(): Promise<CaptchaPolicy> {
  policyPromise ??= import('@career/captcha').then(m => new m.CaptchaPolicy());
  return policyPromise;
}

export async function autoCaptcha(page: CaptchaPage, llm: LLM, assertActive: () => void, allowAttempt = true): Promise<'none' | 'changed' | 'needs_user'> {
  assertActive();
  const cap = await import('@career/captcha');
  const raw = page;
  const guarded = {
    ...raw,
    evalJson: <T>(expr: string): Promise<T> => { assertActive(); return raw.evalJson<T>(expr); },
    cdp: () => {
      const cdp = raw.cdp();
      return cdp ? { send: (method: string, params?: Record<string, unknown>) => { assertActive(); return cdp.send(method, params); } } : null;
    },
  };
  const target = await cap.detectCaptcha(guarded);
  if (!target || target.kind === 'sms') return 'none';
  if (!allowAttempt || (llm.supportsImages && !llm.supportsImages())) return 'needs_user';
  const policy = await getCaptchaPolicy();
  const site = new URL(page.url()).hostname;
  if (inFlight.has(site) || !policy.canAttempt(site).ok) return 'needs_user';
  inFlight.add(site);
  let passed = false;
  try {
    const result = await cap.solveCaptcha({ page: guarded, llm, maxAttempts: 1 }, target);
    assertActive();
    if (result.outcome !== 'passed') return 'needs_user';
    // 不能只靠 solver 的「填过了」当成功，还要重新检测。
    const remaining = await cap.detectCaptcha(guarded);
    passed = !remaining || remaining.kind === 'sms';
    return passed ? 'changed' : 'needs_user';
  } finally {
    policy.record(site, target.kind, passed ? 'passed' : 'failed');
    inFlight.delete(site);
  }
}
