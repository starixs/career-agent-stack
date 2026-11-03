import type { Page } from 'playwright';
import { z } from 'zod';

import type { VerificationTemplate } from './verification-config';

export interface OtpPage {
  url(): string;
  visible(selector: string): Promise<boolean>;
  recipient(selector: string, value: string): Promise<void>;
  click(selector: string, action: 'send' | 'confirm'): Promise<void>;
  code(selectors: string[], value: string): Promise<void>;
}
const stateSchema = z.object({ unique: z.boolean(), visible: z.boolean(), editable: z.boolean(), text: z.string() });
/** 在单一精确 origin 上使用模板；每次异步操作后再次检查，跳转后不把私密值送到新站点。 */
export function otpPage(page: Pick<Page, 'url' | 'evaluate' | 'fill' | 'click'>, template: VerificationTemplate, assertActive: () => void): OtpPage {
  const guard = () => {
    assertActive();
    if (new URL(page.url()).origin !== template.origin) throw new Error('验证页面 origin 已改变');
  };
  const inspect = async (selector: string) => {
    guard();
    const raw: unknown = await page.evaluate(selector => {
      const els = document.querySelectorAll(selector); const el = els[0];
      const r = el?.getBoundingClientRect();
      const visible = !!el && !!r && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      return { unique: els.length === 1, visible, editable: el instanceof HTMLInputElement && !el.disabled && !el.readOnly, text: (el instanceof HTMLElement ? (el.innerText ?? el.textContent ?? '') : '') || (el instanceof HTMLInputElement ? el.value : '') };
    }, selector);
    guard();
    return stateSchema.parse(raw);
  };
  const editable = async (selector: string) => {
    const state = await inspect(selector);
    if (!state.unique || !state.visible || !state.editable) throw new Error('验证码输入框不可操作');
  };
  return {
    url: () => page.url(),
    visible: async s => { const state = await inspect(s); return state.unique && state.visible; },
    recipient: async (s, value) => {
      await editable(s);
      const matches: unknown = await page.evaluate(({ s, value }) => { const el = document.querySelector(s); return el instanceof HTMLInputElement && (!el.value || el.value.trim().toLowerCase() === value.toLowerCase()); }, { s, value });
      guard();
      if (matches !== true) throw new Error('页面接收账号与资料不一致');
      await page.fill(s, value);
    },
    click: async (s, action) => {
      const state = await inspect(s);
      const allowed = action === 'send' ? /^(获取|发送|重新发送)(短信|邮箱|邮件)?验证码$|^(send|get|resend)( verification)? code$/i : /^(登录|登陆|验证|确认验证|验证并登录|登录\/注册|注册\/登录|log ?in|sign in|verify)$/i;
      if (!state.unique || !state.visible || !allowed.test(state.text.trim())) throw new Error('模板按钮不是明确的发码或登录验证动作');
      guard(); await page.click(s);
    },
    code: async (selectors, value) => {
      if (!/^[A-Za-z0-9]{4,8}$/.test(value) || (selectors.length > 1 && selectors.length !== value.length)) throw new Error('验证码长度与输入框不匹配');
      for (const s of selectors) await editable(s);
      // 验证码不进入后续字段规划 / 模型截图；DOM 标记只用于隐私过滤，不表示通过验证。
      guard();
      await page.evaluate(selectors => { for (const s of selectors) { const el = document.querySelector(s); if (el instanceof HTMLInputElement) { el.dataset.careerPrivate = 'otp'; el.style.setProperty('-webkit-text-security', 'disc'); } } }, selectors);
      for (const [i, s] of selectors.entries()) { guard(); await page.fill(s, selectors.length === 1 ? value : value[i]!); }
    },
  };
}
