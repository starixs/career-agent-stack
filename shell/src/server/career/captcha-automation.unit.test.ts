import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectCaptcha, solveCaptcha, type CaptchaPage } from '@career/captcha';
import { FakeLLM } from '@career/core';

import { autoCaptcha, getCaptchaPolicy } from './captcha-automation';

vi.mock('@career/captcha', async importOriginal => {
  const original = await importOriginal<typeof import('@career/captcha')>();
  return { ...original, detectCaptcha: vi.fn(), solveCaptcha: vi.fn() };
});
let index = 0;
function page(): CaptchaPage {
  const site = `test-${index++}.example.org`;
  return { url: () => `https://${site}/`, evalJson: async () => { throw new Error('unexpected eval'); }, screenshot: async () => new Uint8Array(), cdp: () => ({ send: vi.fn(async () => ({})) }), viewport: async () => null, waitForTimeout: async () => undefined };
}
const target = { kind: 'slider' as const, vendor: 'geetest' as const };
beforeEach(() => { vi.mocked(detectCaptcha).mockReset(); vi.mocked(solveCaptcha).mockReset(); });

describe('automatic captcha gating', () => {
  it('requires both solver success and a fresh clear probe; shares policy with browser tools', async () => {
    const p = page();
    vi.mocked(detectCaptcha).mockResolvedValueOnce(target).mockResolvedValueOnce(null);
    vi.mocked(solveCaptcha).mockResolvedValue({ outcome: 'passed', attempts: 1, detail: 'ok' });
    expect(await autoCaptcha(p, new FakeLLM(), () => undefined)).toBe('changed');
    const policy = await getCaptchaPolicy();
    expect(policy.audit().at(-1)).toMatchObject({ site: new URL(p.url()).hostname, outcome: 'passed' });
  });
  it('solver success with challenge still present is failure and enters cooldown', async () => {
    const p = page(); vi.mocked(detectCaptcha).mockResolvedValue(target);
    vi.mocked(solveCaptcha).mockResolvedValue({ outcome: 'passed', attempts: 1, detail: 'ok' });
    expect(await autoCaptcha(p, new FakeLLM(), () => undefined)).toBe('needs_user');
    expect(await autoCaptcha(p, new FakeLLM(), () => undefined)).toBe('needs_user');
    expect(solveCaptcha).toHaveBeenCalledTimes(1);
  });
  it('does not solve OTP and does not block a clear page when round budget is exhausted', async () => {
    vi.mocked(detectCaptcha).mockResolvedValueOnce({ kind: 'sms', vendor: 'unknown' }).mockResolvedValueOnce(null);
    const p = page();
    expect(await autoCaptcha(p, new FakeLLM(), () => undefined)).toBe('none');
    expect(await autoCaptcha(p, new FakeLLM(), () => undefined, false)).toBe('none');
    expect(solveCaptcha).not.toHaveBeenCalled();
  });
  it('rechecks control before each solver input, not only when starting', async () => {
    let human = false;
    vi.mocked(detectCaptcha).mockResolvedValue(target);
    vi.mocked(solveCaptcha).mockImplementation(async deps => {
      human = true;
      await deps.page.cdp()?.send('Input.dispatchMouseEvent');
      return { outcome: 'passed', attempts: 1, detail: 'should not reach' };
    });
    await expect(autoCaptcha(page(), new FakeLLM(), () => { if (human) throw new Error('takeover'); })).rejects.toThrow('takeover');
  });
});
