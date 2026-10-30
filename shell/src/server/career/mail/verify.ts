/**
 * 连接前的真实校验：IMAP 登录 → 打开收件箱（顺便拿 UIDVALIDITY）→ SMTP 认证。
 * 失败按原因分类，界面按 errorCode 给不同的指引。收信通过、发信没通过也算连上（求职主要靠收信），只提示一句。
 */
import type { MailAccount } from '@career/core';

import { smtpSecure } from './providers';

export type MailErrorCode = 'imap_auth_failed' | 'imap_disabled' | 'provider_blocked' | 'unreachable';

export interface VerifyTarget extends Pick<MailAccount, 'address' | 'imap_host' | 'imap_port' | 'smtp_host' | 'smtp_port'> { password: string }

export type VerifyOutcome =
  | { ok: true; uidvalidity: number | null; smtp_ok: boolean; smtp_error?: string }
  | { ok: false; error_code: MailErrorCode; message: string };

export interface VerifyDeps {
  imap?: (t: VerifyTarget) => Promise<{ uidvalidity: number | null }>;
  smtp?: (t: VerifyTarget) => Promise<void>;
  timeoutMs?: number;
}

/** 整个校验最多等这么久：服务器不回话时别让用户一直转圈。 */
export const VERIFY_TIMEOUT_MS = 15_000;

const ERROR_RULES: Array<{ code: MailErrorCode; re: RegExp; message: string }> = [
  { code: 'provider_blocked', re: /unsafe login|kefu@|风控|异常登录/i, message: '邮箱服务商拦下了这次登录。等一分钟再试；还不行，去网页版看看有没有安全提醒要确认。' },
  { code: 'imap_disabled', re: /imap.{0,20}(disabled|not enabled|not open|未开启|关闭)|service.{0,10}not.{0,10}(open|enabled)/i, message: '这个邮箱还没开启 IMAP 服务。回到设置里把 IMAP/SMTP 服务打开。' },
  { code: 'unreachable', re: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|timeout|timed out|socket|network|超时/i, message: '连不上邮箱服务器，检查一下网络后重试。' },
  { code: 'imap_auth_failed', re: /auth|login|credential|password|密码|授权/i, message: '授权码不对或已经失效。复制时可能少了几位，或者被重新生成过，再生成一个试试。' },
];

const ruleOf = (code: MailErrorCode) => ERROR_RULES.find(r => r.code === code)!;

export function classifyMailError(error: unknown): { code: MailErrorCode; message: string; raw: string } {
  const raw = error instanceof Error ? `${error.message} ${(error as { responseText?: string }).responseText ?? ''}`.trim() : String(error);
  if ((error as { authenticationFailed?: boolean } | null)?.authenticationFailed) {
    const blocked = ERROR_RULES.find(r => r.code !== 'imap_auth_failed' && r.code !== 'unreachable' && r.re.test(raw));
    if (blocked) return { code: blocked.code, message: blocked.message, raw };
    return { code: 'imap_auth_failed', message: ruleOf('imap_auth_failed').message, raw };
  }
  const hit = ERROR_RULES.find(r => r.re.test(raw)) ?? ruleOf('unreachable');
  return { code: hit.code, message: hit.message, raw };
}

async function imapProbe(t: VerifyTarget): Promise<{ uidvalidity: number | null }> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: t.imap_host, port: t.imap_port, secure: true, auth: { user: t.address, pass: t.password }, logger: false });
  await client.connect();
  try {
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    return { uidvalidity: box.uidValidity === undefined ? null : Number(box.uidValidity) };
  } finally { await client.logout().catch(() => undefined); }
}

async function smtpProbe(t: VerifyTarget): Promise<void> {
  const nodemailer = await import('nodemailer');
  const transporter = nodemailer.createTransport({ host: t.smtp_host, port: t.smtp_port, secure: smtpSecure(t.smtp_port), auth: { user: t.address, pass: t.password } });
  try { await transporter.verify(); } finally { transporter.close(); }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function verifyMailCredentials(t: VerifyTarget, deps: VerifyDeps = {}): Promise<VerifyOutcome> {
  const run = async (): Promise<VerifyOutcome> => {
    let uidvalidity: number | null;
    try {
      ({ uidvalidity } = await (deps.imap ?? imapProbe)(t));
    } catch (error) {
      const c = classifyMailError(error);
      console.warn(`[career-mail] verify imap failed host=${t.imap_host} code=${c.code}: ${c.raw.slice(0, 200)}`);
      return { ok: false, error_code: c.code, message: c.message };
    }
    try {
      await (deps.smtp ?? smtpProbe)(t);
      return { ok: true, uidvalidity, smtp_ok: true };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.warn(`[career-mail] verify smtp failed host=${t.smtp_host}: ${raw.slice(0, 200)}`);
      return { ok: true, uidvalidity, smtp_ok: false, smtp_error: raw.slice(0, 200) };
    }
  };
  try {
    return await withTimeout(run(), deps.timeoutMs ?? VERIFY_TIMEOUT_MS);
  } catch (error) {
    const c = classifyMailError(error);
    return { ok: false, error_code: c.code, message: c.message };
  }
}
