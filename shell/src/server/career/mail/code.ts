/**
 * 从他连着的邮箱里读注册激活码 / 邮箱验证码（2026-11-03 用户：注册要邮箱验证码的，全自动做完，他一下都不用碰）。
 * 只看点「获取激活码」之后到的信，只取码；信的正文不落库、不进日志、不进模型。
 */
import type { MailAccount, Repos } from '@career/core';

import { getMailPassword } from './credentials';
import { fetchBodies, withInbox, type FetchedMail } from './sync';

/** 激活码信一般十几秒到；等两分钟还没到就算没收到。 */
export const MAIL_CODE_TIMEOUT_MS = 120_000;
/** 每隔几秒查一次收件箱：IMAP 一次连接一两秒，再密网易会限频。 */
const MAIL_CODE_POLL_MS = 6_000;
/** 每次只看最新这几封。 */
const MAIL_CODE_LOOKBACK = 5;
/** 发件时间和本机时间可能差几十秒：往前放宽一点。 */
const CLOCK_SKEW_MS = 60_000;

const CODE_WORD_RX = /(验证码|激活码|校验码|动态码|verification code|activation code|code)/i;
const CODE_NEAR_RX = /(?:验证码|激活码|校验码|动态码|verification code|activation code|code)[^A-Za-z0-9]{0,24}(?:is\s+|为\s*)?([A-Za-z0-9]{4,8})(?![A-Za-z0-9])/gi;
const DIGITS_RX = /(?<![0-9])([0-9]{4,8})(?![0-9])/;

/** 信里的码：先找紧跟在「验证码 / 激活码」后面的，再退到信里唯一像码的一串数字。 */
export function extractMailCode(mail: Pick<FetchedMail, 'subject' | 'text'>): string | null {
  const text = `${mail.subject ?? ''}\n${mail.text}`;
  if (!CODE_WORD_RX.test(text)) return null;
  // 码里至少有一位数字（「code\nYour」里的 Your 不是码）
  const near = [...text.matchAll(CODE_NEAR_RX)].map(m => m[1]).find(c => /\d/.test(c));
  if (near) return near;
  return text.match(DIGITS_RX)?.[1] ?? null;
}

/** 连着的邮箱里，和这个地址一致的那个（填在网站上的就是它）。 */
export function mailboxFor(repos: Repos, address: string): MailAccount | null {
  const a = address.trim().toLowerCase();
  return repos.listMailAccounts().find(x => x.address === a && x.status === 'ok') ?? null;
}

async function newestCodeSince(account: MailAccount, password: string, sinceMs: number): Promise<string | null> {
  return withInbox(account, password, async client => {
    const since = new Date(sinceMs - CLOCK_SKEW_MS);
    const uids = ((await client.search({ since }, { uid: true })) || []).sort((a, b) => a - b).slice(-MAIL_CODE_LOOKBACK);
    const mails = (await fetchBodies(client, uids)).filter(m => !m.received_at || Date.parse(m.received_at) >= sinceMs - CLOCK_SKEW_MS);
    for (const m of mails.reverse()) { const code = extractMailCode(m); if (code) return code; }
    return null;
  });
}

export interface WaitMailCodeOptions { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }

/** 等点了发码之后到的那封信，返回码；超时 null。 */
export async function waitForMailCode(account: MailAccount, sinceMs: number, opts: WaitMailCodeOptions = {}): Promise<string | null> {
  const password = getMailPassword(account.id);
  if (!password) { console.warn(`[career-mail] code: 邮箱 ${account.id} 没有授权码`); return null; }
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + (opts.timeoutMs ?? MAIL_CODE_TIMEOUT_MS);
  while (now() < until) {
    try {
      const code = await newestCodeSince(account, password, sinceMs);
      if (code) { console.log(`[career-mail] code: 邮箱 ${account.id} 收到验证码`); return code; }
    } catch (e) {
      console.warn(`[career-mail] code: 查邮箱 ${account.id} FAILED`, e instanceof Error ? e.message : e);
    }
    await sleep(opts.pollMs ?? MAIL_CODE_POLL_MS);
  }
  console.warn(`[career-mail] code: 邮箱 ${account.id} 等了 ${Math.round((opts.timeoutMs ?? MAIL_CODE_TIMEOUT_MS) / 1000)}s 没收到验证码`);
  return null;
}
