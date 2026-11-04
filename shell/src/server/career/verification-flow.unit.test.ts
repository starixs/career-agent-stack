import { describe, it, expect, vi } from 'vitest';

import { runOtpFlow, type OtpFlowDeps } from './verification-flow';
import { verificationConfigSchema, templateFor } from './verification-config';
import { codeFromMail } from './mail/verification-code';
import { acquireCodeLease } from './verification-source';

const rawTemplate = { id: 'test', origin: 'https://jobs.example.com', channel: 'sms', recipientSelector: '#phone', codeSelectors: ['#otp'], sendSelector: '#send', confirmSelector: '#login', successSelector: '#welcome', smsSignature: '测试招聘', smsRecipient: '13800000000' };
const config = () => verificationConfigSchema.parse({ enabled: true, templates: [rawTemplate] });
function fixture() {
  let submitted = false;
  let claimed = false;
  const close = vi.fn(async () => undefined);
  const wait = vi.fn(async (): Promise<string | null> => '123456');
  const deps: OtpFlowDeps = {
    template: config().templates[0]!, recipient: '13800000000', signal: new AbortController().signal,
    page: { url: () => rawTemplate.origin, visible: vi.fn(async s => s !== '#welcome' || submitted), recipient: vi.fn(async () => undefined), code: vi.fn(async () => undefined), click: vi.fn(async (_s, action) => { if (action === 'confirm') submitted = true; }) },
    prepare: vi.fn(async () => ({ wait, close })), solveCaptcha: vi.fn(async () => 'none' as const),
    claimSend: () => { if (claimed) return false; claimed = true; return true; },
    assertActive: () => undefined, progress: vi.fn(), now: () => 1000, sleep: async () => undefined,
  };
  return { deps, close, wait };
}

describe('OTP flow', () => {
  it.each(['sms', 'email'] as const)('fills %s recipient, obtains a new code, confirms and checks success', async channel => {
    const { deps, close, wait } = fixture(); deps.template.channel = channel;
    expect(await runOtpFlow(deps)).toBe('changed');
    expect(wait).toHaveBeenCalledWith(1000);
    expect(deps.page.code).toHaveBeenCalledWith(['#otp'], '123456');
    expect(deps.page.click).toHaveBeenNthCalledWith(1, '#send', 'send');
    expect(deps.page.click).toHaveBeenNthCalledWith(2, '#login', 'confirm');
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(deps.progress).mock.calls)).not.toContain('123456');
  });
  it('timeout cleans the source, never confirms, never resends on engine retry', async () => {
    const { deps, close, wait } = fixture(); wait.mockResolvedValue(null);
    expect(await runOtpFlow(deps)).toBe('needs_user');
    expect(await runOtpFlow(deps)).toBe('needs_user');
    expect(deps.page.click).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('a typed code is not success without the success selector', async () => {
    const { deps, close } = fixture();
    vi.mocked(deps.page.visible).mockImplementation(async s => s !== '#welcome');
    expect(await runOtpFlow(deps)).toBe('needs_user');
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not send if code source setup fails', async () => {
    const { deps } = fixture(); vi.mocked(deps.prepare).mockRejectedValue(new Error('unavailable'));
    await expect(runOtpFlow(deps)).rejects.toThrow('unavailable');
    expect(deps.page.click).not.toHaveBeenCalled();
  });
  it('aborted after receiving code cannot type or confirm', async () => {
    const { deps, close, wait } = fixture(); const abort = new AbortController(); deps.signal = abort.signal;
    wait.mockImplementation(async () => { abort.abort(); return '123456'; });
    await expect(runOtpFlow(deps)).rejects.toThrow();
    expect(deps.page.code).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it('shared SMS lease is exclusive across sites and cancellable', async () => {
    const release = await acquireCodeLease('test-sms', new AbortController().signal);
    const abort = new AbortController();
    const second = acquireCodeLease('test-sms', abort.signal); abort.abort();
    await expect(second).rejects.toThrow(); release();
    const next = await acquireCodeLease('test-sms', new AbortController().signal); next();
  });
});

describe('verification routing and correlation', () => {
  it('rejects origin suffix tricks, incomplete and ambiguous templates', () => {
    expect(templateFor(config(), 'https://jobs.example.com.evil.test/login')).toBeUndefined();
    expect(verificationConfigSchema.safeParse({ templates: [{ ...rawTemplate, smsSignature: undefined }] }).success).toBe(false);
    expect(verificationConfigSchema.safeParse({ templates: [{ ...rawTemplate, origin: 'http://jobs.example.com' }] }).success).toBe(false);
    const c = config(); c.templates.push({ ...c.templates[0]!, id: 'duplicate-route' });
    expect(templateFor(c, 'https://jobs.example.com/login')).toBeUndefined();
  });
  it('email code must match exact sender, mailbox recipient and arrival time', () => {
    const mail = { sender: 'code@example.com', recipients: ['me@example.org'], receivedAt: 20_000, text: '验证码：123456' };
    expect(codeFromMail(mail, 'code@example.com', 'me@example.org', 19_000)).toBe('123456');
    expect(codeFromMail(mail, 'code@example.com.evil.test', 'me@example.org', 19_000)).toBeNull();
    expect(codeFromMail(mail, 'code@example.com', 'other@example.org', 19_000)).toBeNull();
    expect(codeFromMail(mail, 'code@example.com', 'me@example.org', 30_000)).toBeNull();
    expect(codeFromMail({ ...mail, receivedAt: NaN }, 'code@example.com', 'me@example.org', 19_000)).toBeNull();
  });
});
