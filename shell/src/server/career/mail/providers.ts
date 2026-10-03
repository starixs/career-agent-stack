/**
 * 常见邮箱的 IMAP / SMTP 预设：用户只填地址和授权码（QQ / 163 / 126 需在邮箱设置里开启 IMAP 并生成授权码；
 * Gmail 用应用专用密码；Outlook 用账号密码或应用密码）。其他域名走 imap 自定义。
 */
import type { MailProvider } from '@career/core';

export interface MailProviderPreset { provider: MailProvider; label: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; smtp_secure: boolean; help: string }

export const MAIL_PRESETS: Record<Exclude<MailProvider, 'imap'>, MailProviderPreset> = {
  qq: { provider: 'qq', label: 'QQ 邮箱', imap_host: 'imap.qq.com', imap_port: 993, smtp_host: 'smtp.qq.com', smtp_port: 465, smtp_secure: true, help: 'QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP/SMTP 服务 → 生成授权码，这里填授权码而不是 QQ 密码。' },
  '163': { provider: '163', label: '网易 163 邮箱', imap_host: 'imap.163.com', imap_port: 993, smtp_host: 'smtp.163.com', smtp_port: 465, smtp_secure: true, help: '163 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP → 新增授权密码，这里填授权密码。' },
  '126': { provider: '126', label: '网易 126 邮箱', imap_host: 'imap.126.com', imap_port: 993, smtp_host: 'smtp.126.com', smtp_port: 465, smtp_secure: true, help: '与 163 相同：开启 IMAP 后用授权密码登录。' },
  gmail: { provider: 'gmail', label: 'Gmail', imap_host: 'imap.gmail.com', imap_port: 993, smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true, help: 'Google 账号 → 安全性 → 两步验证 → 应用专用密码，这里填 16 位应用密码。' },
  outlook: { provider: 'outlook', label: 'Outlook / Hotmail', imap_host: 'outlook.office365.com', imap_port: 993, smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: false, help: 'Outlook 需要在账户安全里开启 IMAP；若启用了两步验证请使用应用密码。' },
};

export function detectProvider(address: string): MailProvider {
  const domain = address.split('@')[1]?.toLowerCase() ?? '';
  if (domain === 'qq.com' || domain === 'foxmail.com') return 'qq';
  if (domain === '163.com') return '163';
  if (domain === '126.com' || domain === 'yeah.net') return '126';
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (/^(outlook|hotmail|live)\./.test(domain)) return 'outlook';
  return 'imap';
}

export function presetFor(provider: MailProvider): MailProviderPreset | null {
  return provider === 'imap' ? null : MAIL_PRESETS[provider];
}

export function smtpSecure(port: number): boolean { return port === 465; }
