import { DETECT_CAPTCHA_EXPR } from '@career/captcha';
import { extractFieldsScript } from '@career/apply';
import type { Page } from 'playwright';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { verificationConfigSchema } from './verification-config';
import { otpPage } from './verification-page';

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

function fixture() {
  document.body.innerHTML = '<input id="phone"><input id="code"><button id="send">获取验证码</button><button id="login">登录</button><button id="submit">提交申请</button>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 100, 30));
  const fill = vi.fn<Page['fill']>(async (selector, value) => { window.eval(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}`); });
  const click = vi.fn<Page['click']>(async () => undefined);
  const evaluate = vi.fn<Page['evaluate']>(async (fn: Parameters<Page['evaluate']>[0], arg: unknown) => window.eval(typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(arg)})`));
  let url = 'https://jobs.example.com/login';
  const t = verificationConfigSchema.parse({ templates: [{ id: 'sms', origin: 'https://jobs.example.com', channel: 'sms', recipientSelector: '#phone', codeSelectors: ['#code'], sendSelector: '#send', confirmSelector: '#login', successSelector: '#ok', smsSignature: 'Example', smsRecipient: '13800000000' }] }).templates[0]!;
  const page = otpPage({ url: () => url, evaluate, fill, click }, t, () => undefined);
  return { page, fill, click, navigate: (to: string) => { url = to; } };
}

describe('OTP template DOM boundary', () => {
  it('does not send OTP to graphical OCR, ignore hidden widgets and identify Turnstile correctly', () => {
    fixture();
    document.body.innerHTML = '<input autocomplete="one-time-code" placeholder="请输入验证码"><div class="geetest_slider_button" style="display:none"></div><div class="prompt">提示</div>';
    expect(window.eval(DETECT_CAPTCHA_EXPR)).toMatchObject({ kind: 'sms', vendor: 'unknown' });
    document.body.innerHTML = '<div class="geetest_slider_button" style="display:none"></div>';
    expect(window.eval(DETECT_CAPTCHA_EXPR)).toBeNull();
    document.body.innerHTML = '<div class="cf-turnstile" data-sitekey="test"></div>';
    expect(window.eval(DETECT_CAPTCHA_EXPR)).toMatchObject({ kind: 'browser_check', vendor: 'turnstile' });
  });
  it('executes serialized probes, masks OTP and excludes it from field extraction', async () => {
    const { page, fill, click } = fixture();
    await page.recipient('#phone', '13800000000');
    await page.click('#send', 'send');
    await page.code(['#code'], '123456');
    expect(fill).toHaveBeenCalledWith('#code', '123456');
    expect(document.querySelector('#code')?.getAttribute('data-career-private')).toBe('otp');
    expect(click).toHaveBeenCalledWith('#send');
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
    const fields = await extractFieldsScript.fn();
    expect(fields.some(f => f.name === 'phone')).toBe(true);
    expect(fields.some(f => f.name === 'code' || f.value === '123456')).toBe(false);
  });
  it('rejects submission buttons, ambiguous selectors and mismatching recipients', async () => {
    const { page, click } = fixture();
    await expect(page.click('#submit', 'confirm')).rejects.toThrow();
    await expect(page.click('button', 'send')).rejects.toThrow();
    window.eval('document.querySelector("#phone").value = "13900000000"');
    await expect(page.recipient('#phone', '13800000000')).rejects.toThrow();
    expect(click).not.toHaveBeenCalled();
  });
  it('refuses cross-origin navigation before typing', async () => {
    const { page, navigate, fill } = fixture();
    navigate('https://other.example.com/login');
    await expect(page.code(['#code'], '123456')).rejects.toThrow('origin');
    expect(fill).not.toHaveBeenCalled();
  });
  it('supports split-digit OTP without silently truncating codes', async () => {
    const { page, fill } = fixture();
    document.body.innerHTML = '<input id="a"><input id="b"><input id="c"><input id="d">';
    await page.code(['#a', '#b', '#c', '#d'], '0123');
    expect(fill.mock.calls.map(call => call[1])).toEqual(['0', '1', '2', '3']);
    await expect(page.code(['#a', '#b', '#c', '#d'], '123456')).rejects.toThrow();
  });
});
