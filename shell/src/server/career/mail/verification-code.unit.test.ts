import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareMailCode } from './verification-code';

const fake = vi.hoisted(() => ({
  mailbox: { uidNext: 11, uidValidity: 1n }, connect: vi.fn(), close: vi.fn(), release: vi.fn(),
  getMailboxLock: vi.fn(), on: vi.fn(), search: vi.fn(), fetchOne: vi.fn(),
}));
vi.mock('imapflow', () => ({ ImapFlow: class { constructor() { return fake; } } }));
const account = { address: 'me@example.org', imap_host: 'imap.example.org', imap_port: 993 };
const received = new Date('2026-11-03T10:00:02Z');
const since = received.getTime() - 2000;

beforeEach(() => {
  vi.resetAllMocks(); fake.mailbox = { uidNext: 11, uidValidity: 1n };
  fake.connect.mockResolvedValue(undefined);
  fake.getMailboxLock.mockResolvedValue({ release: fake.release });
  fake.search.mockResolvedValue([10, 11]);
  fake.fetchOne.mockImplementation(async (_uid, fields: { source?: boolean }) => fields.source
    ? { source: Buffer.from('From: code@example.com\r\nTo: me@example.org\r\nSubject: Verification code\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour verification code is 123456') }
    : { envelope: { from: [{ address: 'code@example.com' }] }, internalDate: received, size: 500 });
});

describe('private IMAP code source', () => {
  it('freezes a UID baseline before send, reads only newer mail, and releases resources', async () => {
    const source = await prepareMailCode(account, 'test-secret', 'code@example.com', new AbortController().signal);
    expect(fake.search).not.toHaveBeenCalled();
    expect(await source.wait(since)).toBe('123456');
    expect(fake.search).toHaveBeenCalledWith({ uid: '11:*' }, { uid: true });
    expect(fake.fetchOne.mock.calls.every(call => call[0] === '11')).toBe(true);
    await source.close(); expect(fake.release).toHaveBeenCalledOnce(); expect(fake.close).toHaveBeenCalledOnce();
  });
  it('rejects changed UIDVALIDITY rather than reusing historical UIDs', async () => {
    const source = await prepareMailCode(account, 'test-secret', 'code@example.com', new AbortController().signal);
    fake.mailbox.uidValidity = 2n;
    expect(await source.wait(since)).toBeNull(); expect(fake.search).not.toHaveBeenCalled();
    await source.close();
  });
  it('does not download a body from the wrong sender or an oversized message', async () => {
    const abort = new AbortController();
    fake.search.mockResolvedValue([11, 12]);
    fake.fetchOne.mockImplementation(async (uid: string) => {
      if (uid === '12') abort.abort();
      return { envelope: { from: [{ address: uid === '11' ? 'wrong@example.com' : 'code@example.com' }] }, internalDate: received, size: uid === '12' ? 1_000_000 : 500 };
    });
    const source = await prepareMailCode(account, 'test-secret', 'code@example.com', abort.signal);
    await expect(source.wait(since)).rejects.toThrow();
    expect(fake.fetchOne.mock.calls.every(call => !call[1].source)).toBe(true);
    await source.close();
  });
  it('cancels the socket while awaiting code, never includes credentials in setup errors', async () => {
    const abort = new AbortController();
    const source = await prepareMailCode(account, 'test-secret', 'code@example.com', abort.signal);
    abort.abort(); expect(fake.close).toHaveBeenCalledOnce();
    expect(await source.wait(since)).toBeNull(); await source.close();
    fake.connect.mockRejectedValue(new Error('password=test-secret'));
    await expect(prepareMailCode(account, 'test-secret', 'code@example.com', new AbortController().signal)).rejects.toThrow('邮箱收码连接失败');
  });
});
