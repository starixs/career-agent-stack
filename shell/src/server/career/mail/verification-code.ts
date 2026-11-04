import { setTimeout as delay } from 'node:timers/promises';
import type { MailAccount } from '@career/core';

import { extractCode } from '../phone/sms-code';
import type { PreparedCode } from '../verification-source';

/** 等码时单连接短轮询，不触动求职邮件同步游标；正文只在内存中解析。 */
const POLL_MS = 3000;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_NEW_MESSAGES = 30;
const SOCKET_TIMEOUT_MS = 15_000;
const CLOCK_PRECISION_MS = 1000;
type Client = InstanceType<typeof import('imapflow').ImapFlow>;

export interface CodeMail { sender: string; recipients: string[]; receivedAt: number; text: string }
export function codeFromMail(mail: CodeMail, sender: string, recipient: string, since: number): string | null {
  if (mail.sender.toLowerCase() !== sender.toLowerCase() || !mail.recipients.some(r => r.toLowerCase() === recipient.toLowerCase())) return null;
  if (!Number.isFinite(mail.receivedAt) || mail.receivedAt < since - CLOCK_PRECISION_MS) return null;
  return extractCode(mail.text);
}

async function readCode(client: Client, afterUid: number, sender: string, recipient: string, since: number): Promise<{ code: string | null; cursor: number }> {
  const { simpleParser } = await import('mailparser');
  const uids = ((await client.search({ uid: `${afterUid + 1}:*` }, { uid: true })) || []).filter(u => u > afterUid).sort((a, b) => a - b);
  let cursor = afterUid;
  for (const uid of uids.slice(0, MAX_NEW_MESSAGES)) {
    const head = await client.fetchOne(String(uid), { envelope: true, internalDate: true, size: true }, { uid: true });
    cursor = uid;
    if (!head || !head.size || head.size > MAX_MESSAGE_BYTES) continue;
    const from = head.envelope?.from?.map(a => a.address ?? '') ?? [];
    if (from.length !== 1 || from[0]?.toLowerCase() !== sender.toLowerCase()) continue;
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const parsed = await simpleParser(msg.source, { skipHtmlToText: false, skipTextToHtml: true });
    const to = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap(a => a.value.map(v => v.address ?? '')) : [];
    const code = codeFromMail({ sender: from[0]!, recipients: to, receivedAt: new Date(head.internalDate ?? '').getTime(), text: `${parsed.subject ?? ''}\n${parsed.text ?? ''}` }, sender, recipient, since);
    if (code) return { code, cursor };
  }
  return { code: null, cursor };
}

/** 部分 163 邮箱的 EXAMINE / STATUS 不返回 UIDNEXT；只取最高 UID，不读正文或扫描历史。 */
async function freezeBaseline(client: Client): Promise<{ cursor: number; validity: string }> {
  const mailbox = client.mailbox;
  if (!mailbox || typeof mailbox.uidValidity !== 'bigint' || mailbox.uidValidity <= 0n) throw new Error('邮箱没有 UID 身份');
  const validity = String(mailbox.uidValidity);
  if (mailbox.uidNext !== undefined) {
    if (!Number.isSafeInteger(mailbox.uidNext) || mailbox.uidNext < 1) throw new Error('无效 UID 基线');
    return { cursor: mailbox.uidNext - 1, validity };
  }
  if (!Number.isSafeInteger(mailbox.exists) || mailbox.exists < 0) throw new Error('无效邮箱状态');
  if (mailbox.exists === 0) return { cursor: 0, validity };
  const last = await client.fetchOne('*', { uid: true }, { uid: true });
  if (!last || !Number.isSafeInteger(last.uid) || last.uid < 1
    || !client.mailbox || String(client.mailbox.uidValidity) !== validity) throw new Error('无法冻结 UID 基线');
  return { cursor: last.uid, validity };
}

/** 在发码前建立 IMAP 会话、冻结 UID 基线；旧码即使标为未读也不会被选中。 */
export async function prepareMailCode(account: Pick<MailAccount, 'address' | 'imap_host' | 'imap_port'>, password: string, sender: string, signal: AbortSignal): Promise<PreparedCode> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: account.imap_host, port: account.imap_port, secure: true, auth: { user: account.address, pass: password }, logger: false, connectionTimeout: SOCKET_TIMEOUT_MS, socketTimeout: SOCKET_TIMEOUT_MS });
  const abort = () => client.close();
  client.on('error', () => { console.warn('[apply-verification] IMAP transport error'); });
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  let release: (() => void) | undefined;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    release = () => lock.release();
    const baseline = await freezeBaseline(client);
    signal.throwIfAborted();
    let cursor = baseline.cursor;
    const validity = baseline.validity;
    return {
      wait: async since => {
        while (!signal.aborted) {
          if (!client.mailbox || String(client.mailbox.uidValidity) !== validity) return null;
          const result = await readCode(client, cursor, sender, account.address, since);
          cursor = result.cursor;
          if (result.code) return result.code;
          await delay(POLL_MS, undefined, { signal });
        }
        return null;
      },
      close: async () => { signal.removeEventListener('abort', abort); lock.release(); client.close(); },
    };
  } catch {
    signal.removeEventListener('abort', abort); release?.(); client.close();
    throw new Error('邮箱收码连接失败');
  }
}
