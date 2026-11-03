import { setTimeout as delay } from 'node:timers/promises';
import type { Repos } from '@career/core';

import { getMailPassword } from './mail/credentials';
import { prepareMailCode } from './mail/verification-code';
import { phoneLink } from './phone';
import type { VerificationTemplate } from './verification-config';

export interface PreparedCode {
  wait(since: number): Promise<string | null>;
  close(): Promise<void>;
}

/** 一部手机跨网站也必须串行，避免两个页面同一签名串码；邮箱按账号串行。 */
const leases = new Set<string>();
const LEASE_POLL_MS = 250;
export async function acquireCodeLease(key: string, signal: AbortSignal): Promise<() => void> {
  while (leases.has(key)) await delay(LEASE_POLL_MS, undefined, { signal });
  signal.throwIfAborted();
  leases.add(key);
  return () => { leases.delete(key); };
}

/** 先确认通道可读，再点击发码。云端凭证不在本机时不猜接口、不降级到别的邮箱。 */
export async function prepareCodeSource(repos: Repos, template: VerificationTemplate, recipient: string, signal: AbortSignal): Promise<PreparedCode> {
  if (template.channel === 'sms') {
    if (template.smsRecipient !== recipient) throw new Error('手机号与配对确认配置不一致');
    const phone = await phoneLink();
    if (phone.status().state !== 'connected') throw new Error('手机未连接');
    return {
      wait: async since => (await phone.waitForCode({ since, signature: template.smsSignature, strict: true, timeoutMs: 120_000, signal }))?.code ?? null,
      close: async () => undefined,
    };
  }
  const account = repos.listMailAccounts().find(a => a.address.toLowerCase() === recipient.toLowerCase());
  if (!account || account.remote_id) throw new Error('自动收码需要与网申地址一致的本机邮箱连接');
  const password = getMailPassword(account.id);
  if (!password || !template.mailSender) throw new Error('邮箱收码配置不完整');
  return prepareMailCode(account, password, template.mailSender, signal);
}
