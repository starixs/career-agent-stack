import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { careerDataDir } from './db';

const selector = z.string().trim().min(1).max(500);
const origin = z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && u.origin === v; }, '必须是精确的 HTTPS origin，不带路径');
const template = z.object({
  id: z.string().min(1).max(80), origin,
  pathPrefix: z.string().startsWith('/').default('/'),
  channel: z.enum(['sms', 'email']),
  recipientSelector: selector,
  codeSelectors: z.array(selector).min(1).max(8),
  sendSelector: selector,
  confirmSelector: selector.optional(),
  successSelector: selector,
  smsSignature: z.string().trim().min(1).optional(),
  /** 用户确认配对手机对应此号码；蓝牙 MAP 不提供可靠的本机号码。 */
  smsRecipient: z.string().regex(/^\+?[0-9]{7,15}$/).optional(),
  mailSender: z.email().optional(),
}).strict().superRefine((t, ctx) => {
  if (t.channel === 'sms' && (!t.smsSignature || !t.smsRecipient)) ctx.addIssue({ code: 'custom', message: '短信模板必须指定精确签名与配对手机号码', path: ['smsSignature'] });
  if (t.channel === 'email' && !t.mailSender) ctx.addIssue({ code: 'custom', message: '邮箱模板必须指定精确发件地址', path: ['mailSender'] });
  if (new Set(t.codeSelectors).size !== t.codeSelectors.length || t.codeSelectors.includes(t.recipientSelector)) ctx.addIssue({ code: 'custom', message: '验证码输入框必须各不相同，且不能是账号输入框', path: ['codeSelectors'] });
  if ([t.recipientSelector, t.sendSelector, t.confirmSelector, ...t.codeSelectors].includes(t.successSelector)) ctx.addIssue({ code: 'custom', message: '成功标志不能是验证表单控件', path: ['successSelector'] });
});
export const verificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  captcha: z.boolean().default(true),
  timeoutMs: z.number().int().min(5_000).max(120_000).default(90_000),
  templates: z.array(template).max(200).default([]),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.templates.map(t => t.id)).size !== c.templates.length) ctx.addIssue({ code: 'custom', message: '模板 id 不能重复' });
});
export type VerificationConfig = z.infer<typeof verificationConfigSchema>;
export type VerificationTemplate = z.infer<typeof template>;

/** 私有配置只在 Global 宿主读取，不能从模型工具 body 接收站点授权。无文件时不开启自动收码。 */
export async function loadVerificationConfig(): Promise<VerificationConfig> {
  let text: string;
  try { text = await readFile(join(careerDataDir(), 'verification.json'), 'utf8'); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return verificationConfigSchema.parse({});
    throw new Error('读取 verification.json 失败');
  }
  const parsed = verificationConfigSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('verification.json 格式不正确，请核对配置说明');
  return parsed.data;
}

export function templateFor(config: VerificationConfig, url: string): VerificationTemplate | undefined {
  const u = new URL(url);
  const matches = config.templates.filter(t => t.origin === u.origin && u.pathname.startsWith(t.pathPrefix));
  // 重叠模板不能猜：配置者应收窄路径。
  return matches.length === 1 ? matches[0] : undefined;
}
