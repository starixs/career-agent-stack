/**
 * 邮箱连接器目录：每家邮箱怎么连（授权方式、能力、官方页面、拿授权码的引导、凭证字段）都是数据，
 * 界面按这份数据渲染，新增一家邮箱不用改界面。只收个人邮箱（QQ / 网易 / Gmail），学校和企业邮箱不做。
 *
 * 授权码都存在本机（credentials.ts），不上云：真北「私密只在本机」。
 * 引导里的设置路径来自各家网页版当前的菜单文字，未在真实账号上逐项核对过；改版时只改这里。
 */
import type { MailAccount, MailProvider } from '@career/core';

import { MAIL_PRESETS } from './providers';

export type ConnectorId = Extract<MailProvider, 'qq' | '163' | '126' | 'gmail'>;

export interface ConnectorGuideStep { title: string; text: string; path?: string[] }
export interface CredentialField { key: 'email' | 'authCode'; type: 'email' | 'secret'; label: string; placeholder: string; helper?: string; length?: number }

export interface MailConnector {
  id: ConnectorId;
  name: string;
  /** credential_form：官方页面拿授权码再填回来；oauth：官方授权页（保留，Gmail 过审后再开）。 */
  auth_type: 'credential_form' | 'oauth';
  capabilities: Array<'receive' | 'send'>;
  /** 在用户自己的浏览器里打开的官方页面。 */
  open_url: string;
  open_label: string;
  help_url: string | null;
  guide: ConnectorGuideStep[];
  /** 拿授权码时官方要求的验证（这一步省不掉）。 */
  verify_note: string;
  fields: CredentialField[];
}

const AUTH_CODE_LENGTH = 16;

const emailField = (placeholder: string): CredentialField => ({ key: 'email', type: 'email', label: '邮箱地址', placeholder });
const codeField = (helper: string): CredentialField => ({ key: 'authCode', type: 'secret', label: '授权码', placeholder: `${AUTH_CODE_LENGTH} 位字母`, helper, length: AUTH_CODE_LENGTH });

const NETEASE_GUIDE = (site: string): ConnectorGuideStep[] => [
  { title: `打开 ${site} 网页版`, text: '在你常用的浏览器里打开；没登录就按页面提示登录。' },
  { title: '开启 IMAP 并新增授权密码', text: '按这个路径找到开关，开启后点「新增授权密码」。', path: ['设置', 'POP3/SMTP/IMAP', '开启 IMAP/SMTP 服务', '新增授权密码'] },
  { title: '复制授权码', text: '授权码只显示一次，复制后再关窗口。' },
];

export const MAIL_CONNECTORS: Record<ConnectorId, MailConnector> = {
  qq: {
    id: 'qq', name: 'QQ 邮箱', auth_type: 'credential_form', capabilities: ['receive', 'send'],
    open_url: 'https://wx.mail.qq.com/', open_label: '打开 QQ 邮箱', help_url: 'https://service.mail.qq.com/detail/0/75',
    guide: [
      { title: '打开 QQ 邮箱网页版', text: '在你常用的浏览器里打开；没登录就按页面提示扫码。' },
      { title: '开启服务并生成授权码', text: '按这个路径找到「POP3/IMAP/SMTP 服务」，开启后点「生成授权码」。', path: ['设置', '账号与安全', '安全设置', 'POP3/IMAP/SMTP 服务', '生成授权码'] },
      { title: '复制授权码', text: '生成后复制那 16 位字母。' },
    ],
    verify_note: '生成授权码时，QQ 邮箱会要你用微信扫码或发一条短信验证。',
    fields: [emailField('you@qq.com'), codeField('16 位字母，不是 QQ 密码')],
  },
  '163': {
    id: '163', name: '163 邮箱', auth_type: 'credential_form', capabilities: ['receive', 'send'],
    open_url: 'https://mail.163.com/', open_label: '打开 163 邮箱', help_url: null,
    guide: NETEASE_GUIDE('163 邮箱'),
    verify_note: '开启服务时，网易会要你发一条短信验证。',
    fields: [emailField('you@163.com'), codeField('16 位字母，不是邮箱密码')],
  },
  '126': {
    id: '126', name: '126 邮箱', auth_type: 'credential_form', capabilities: ['receive', 'send'],
    open_url: 'https://mail.126.com/', open_label: '打开 126 邮箱', help_url: null,
    guide: NETEASE_GUIDE('126 邮箱'),
    verify_note: '开启服务时，网易会要你发一条短信验证。',
    fields: [emailField('you@126.com'), codeField('16 位字母，不是邮箱密码')],
  },
  gmail: {
    // OAuth 读信属于谷歌「受限范围」，要过审才能对外开放；过审前用应用专用密码，和其他几家同一套流程。
    id: 'gmail', name: 'Gmail', auth_type: 'credential_form', capabilities: ['receive', 'send'],
    open_url: 'https://myaccount.google.com/apppasswords', open_label: '打开「应用专用密码」页', help_url: 'https://support.google.com/accounts/answer/185833',
    guide: [
      { title: '打开 Google 账号的「应用专用密码」页', text: '在你常用的浏览器里打开。看不到这一页，说明还没开两步验证，先开再回来。' },
      { title: '创建一个应用专用密码', text: '名字随便填，比如「求职助手」，点「创建」。', path: ['Google 账号', '安全性', '两步验证', '应用专用密码', '创建'] },
      { title: '复制 16 位密码', text: '中间的空格可以一起复制，填回来时会自动去掉。' },
    ],
    verify_note: '需要先开两步验证；工作或学校的 Google 账号可能用不了应用专用密码。',
    fields: [emailField('you@gmail.com'), codeField('16 位字母，空格可以一起粘')],
  },
};

/** 列表顺序（对象键里的「163」「126」会被 JS 排到最前，不能直接 Object.values）。 */
export const CONNECTOR_ORDER: readonly ConnectorId[] = ['qq', '163', '126', 'gmail'];

export function isConnectorId(value: unknown): value is ConnectorId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MAIL_CONNECTORS, value);
}

/** 授权码去掉空格；格式不对返回 null（16 位字母，大小写各家不同，不强求）。 */
export function normalizeAuthCode(raw: string): string | null {
  const code = raw.replace(/\s+/g, '');
  return new RegExp(`^[A-Za-z]{${AUTH_CODE_LENGTH}}$`).test(code) ? code : null;
}

export function connectorServers(id: ConnectorId): Pick<MailAccount, 'imap_host' | 'imap_port' | 'smtp_host' | 'smtp_port'> {
  const p = MAIL_PRESETS[id];
  return { imap_host: p.imap_host, imap_port: p.imap_port, smtp_host: p.smtp_host, smtp_port: p.smtp_port };
}

/** 连接状态（界面是投影，判定只在这里）：失效 = 连续认证失败到阈值；降级 = 最近有失败但还没到阈值。 */
export type ConnectionState = 'active' | 'expired' | 'verifying';
export type ConnectionHealth = 'healthy' | 'degraded' | 'expired';

export function connectionOf(a: MailAccount): { state: ConnectionState; health: ConnectionHealth } {
  if (a.status === 'auth_failed') return { state: 'expired', health: 'expired' };
  if (a.status === 'unverified') return { state: 'verifying', health: 'healthy' };
  return { state: 'active', health: a.status === 'error' || a.consecutive_fails > 0 ? 'degraded' : 'healthy' };
}
