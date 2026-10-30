import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadCore } from '../core-module';
import { SERVER_CONFIG_KEY } from '../server-api';
import { createMemoryRepos } from '../test-db';
import { mailBackend } from './backend';
import { getMailPassword, setMailCredentialsPath } from './credentials';
import { executeSendMailAction } from './send';

vi.mock('../../sse', () => ({ broadcast: vi.fn() }));

const BASE = 'https://api.test';
const NOW = '2026-10-30T08:00:00.000Z';

const connection = (over: Record<string, unknown> = {}) => ({
  id: 'conn_1', provider: 'qq', auth_type: 'credential_form', email_address: 'me@qq.com', status: 'active',
  health: { status: 'healthy', last_check_at: null, last_ok_at: null, consecutive_fails: 0, last_error: null },
  created_at: '2026-10-30T00:00:00Z', last_used_at: null, last_sync_at: null, ...over,
});

/** 假云端：按路径回包，记下每次请求。 */
function fakeCloud(routes: Record<string, (body: unknown, url: URL) => unknown>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(handler(body, url)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-cloud-')); setMailCredentialsPath(join(dir, 'c.json')); });
afterEach(() => { setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

async function cloudDeps() {
  const repos = createMemoryRepos();
  repos.kvSet(SERVER_CONFIG_KEY, { base_url: BASE, token: 't' });
  const core = await loadCore();
  return { repos, core, llm: null, broadcast: () => undefined, sessionId: () => 'global', now: () => NOW };
}

describe('邮箱连接器 · 云端', () => {
  it('目录从云端拿，拿不到用内置；连接走云端校验，本机不存授权码，只镜像连接', async () => {
    const d = await cloudDeps();
    const { fetchImpl, calls } = fakeCloud({
      'POST /v1/connectors/qq/credentials/verify': () => ({ ok: true, smtp_ok: true, connection: connection() }),
      'GET /v1/connections': () => ({ connections: [connection()] }),
    });
    const backend = mailBackend(d, { fetchImpl });
    expect(backend.kind).toBe('cloud');
    expect((await backend.catalog()).map(c => c.id)).toEqual(['qq', '163', '126', 'gmail']);

    const res = await backend.connect({ connector: 'qq', email: 'Me@QQ.com', authCode: 'abcd efgh ijkl mnop' });
    expect(res).toMatchObject({ ok: true, account: { address: 'me@qq.com', remote_id: 'conn_1', status: 'ok' } });
    expect(calls.find(c => c.path.endsWith('/verify'))?.body).toEqual({ email: 'me@qq.com', authCode: 'abcdefghijklmnop', reauthorize: false });
    expect(getMailPassword(res.ok ? res.account.id : '')).toBeNull();
  });

  it('事件流：历史回填接管成申请，游标逐页前移；没见过的连接先刷新再认', async () => {
    const d = await cloudDeps();
    const pages: Record<string, unknown> = {
      '': { events: [{ id: 'e1', connection_id: 'conn_1', uid: 1, message_id: '<m1@x>', in_reply_to: null, from: '美团校园招聘 <noreply@mokahr.com>', to: 'me@qq.com', subject: '【美团】已收到您的简历', received_at: '2026-08-20T02:00:00Z', backfill: true, text: '感谢投递' }], next_cursor: 'c1' },
      c1: { events: [{ id: 'e2', connection_id: 'conn_1', uid: 2, message_id: '<m2@x>', in_reply_to: null, from: 'hr@jd.com', to: 'me@qq.com', subject: '京东集团校园招聘：很遗憾', received_at: '2026-09-20T02:00:00Z', backfill: true, text: '……' }], next_cursor: null },
    };
    const { fetchImpl } = fakeCloud({
      'GET /v1/connections': () => ({ connections: [connection()] }),
      'GET /v1/mail/events': (_b, url) => pages[url.searchParams.get('since') ?? ''],
    });
    const results = await mailBackend(d, { fetchImpl }).poll();
    expect(results.every(r => r.history)).toBe(true);
    const stages = Object.fromEntries(d.repos.applicationsWithJob().map(a => [a.job.company_name, a.stage]));
    expect(stages).toEqual({ 美团: 'applied', 京东: 'rejected' });
    expect(d.repos.kvGet('mail:events:cursor')).toBe('c1');
  });

  it('管理页的用量与记录来自云端；解绑调云端删除；失效状态镜像成需要重新授权', async () => {
    const d = await cloudDeps();
    const { fetchImpl, calls } = fakeCloud({
      'GET /v1/connections': () => ({ connections: [connection({ status: 'expired', health: { status: 'expired', last_check_at: null, last_ok_at: null, consecutive_fails: 3, last_error: '授权码不对' } })] }),
      'GET /v1/connections/conn_1/usage': () => ({ days: 7, by_op: { send: { ok: 2, failed: 0 } } }),
      'GET /v1/connections/conn_1/audit': () => ({ entries: [{ id: 'a1', actor: 'agent', operation: 'send', status: 'ok', detail: { to: ['hr@x.com'] }, latency_ms: 200, created_at: NOW }] }),
      'DELETE /v1/connections/conn_1': () => ({}),
    });
    const backend = mailBackend(d, { fetchImpl });
    await backend.refresh();
    const account = d.repos.getMailAccountByRemote('conn_1')!;
    expect(account.status).toBe('auth_failed');
    const detail = await backend.detail(account);
    expect(detail.account.connection.state).toBe('expired');
    expect(detail.usage.by_op.send.ok).toBe(2);
    expect(detail.audit[0]).toMatchObject({ actor: 'agent', operation: 'send' });
    await backend.unbind(account);
    expect(calls.some(c => c.method === 'DELETE' && c.path === '/v1/connections/conn_1')).toBe(true);
    expect(d.repos.listMailAccounts()).toEqual([]);
  });

  it('OAuth 轨未开启时如实返回；云端目录挂了退回内置目录', async () => {
    const d = await cloudDeps();
    const { fetchImpl } = fakeCloud({ 'POST /v1/connectors/gmail/oauth/start': () => ({ error_code: 'oauth_not_enabled', message: '审核后开放' }) });
    const backend = mailBackend(d, { fetchImpl });
    expect(await backend.oauthStart('gmail')).toEqual({ ok: false, error_code: 'oauth_not_enabled', message: '审核后开放' });
    expect((await backend.catalog()).find(c => c.id === 'gmail')?.oauth).toEqual({ enabled: false });
  });

  it('代发：云端连接不需要本机授权码，附件转 base64 带哈希，按动作 id 幂等', async () => {
    const d = await cloudDeps();
    const account = d.repos.mirrorMailAccount({ remote_id: 'conn_1', provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com', status: 'ok', last_error: null, consecutive_fails: 0, last_ok_at: null, last_check_at: null, last_sync_at: null, created_at: NOW });
    const file = join(dir, '简历.pdf');
    writeFileSync(file, 'PDF');
    const { fetchImpl, calls } = fakeCloud({ 'POST /v1/mail/send': () => ({ message_id: '<out1@x>' }) });
    vi.stubGlobal('fetch', fetchImpl);
    const action = d.repos.enqueueAction('send_mail', { account_id: account.id, to: 'hr@b.com', subject: '应聘产品', body: '正文', attachments: [{ path: file, filename: '简历.pdf' }] });
    d.repos.reviewActions([action.id], 'approved');
    await executeSendMailAction(d, d.repos.getAction(action.id)!);
    const sent = calls.find(c => c.path === '/v1/mail/send')?.body as { connection_id: string; trigger: string; attachments: Array<{ content_base64: string; sha256: string }> };
    expect(sent).toMatchObject({ connection_id: 'conn_1', trigger: action.id });
    expect(Buffer.from(sent.attachments[0].content_base64, 'base64').toString()).toBe('PDF');
    expect(sent.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
