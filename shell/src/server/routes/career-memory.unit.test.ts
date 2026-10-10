import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StaticKeyProvider, Vault, type Repos } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute, type CareerRouteDeps } from './career';

// `/api/career/memories`：「助理记住的事」页面的看 / 改 / 删 / 置顶 / 手动加。

const dirs: string[] = [];
async function call(deps: CareerRouteDeps, method: string, path: string, body?: unknown) {
  const request = new Request(`http://local${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
  const response = await handleCareerRoute(new URL(request.url).pathname, request, deps);
  if (!response) throw new Error(`route returned null for ${method} ${path}`);
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('长期记忆路由', () => {
  let repos: Repos;
  let deps: CareerRouteDeps & { events: Array<{ event: string; data: unknown }> };

  beforeEach(() => {
    repos = createMemoryRepos();
    const vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 1)));
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
    const dir = mkdtempSync(join(tmpdir(), 'career-memory-route-')); dirs.push(dir);
    const events: Array<{ event: string; data: unknown }> = [];
    deps = { repos, vault, events, broadcast: (event, data) => { events.push({ event, data }); }, sessionId: () => 'sess-1', exportsDir: dir, llm: null };
  });
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('手动加 → 列表 / 检索 → 改内容与置顶 → 忘掉', async () => {
    const added = await call(deps, 'POST', '/api/career/memories', { content: '用户希望先说结论', kind: 'collaboration' });
    expect(added.status).toBe(200);
    const id = (added.json.memory as { id: string }).id;
    expect(deps.events.some(e => e.event === 'career:data-changed' && (e.data as { tables: string[] }).tables.includes('memory'))).toBe(true);
    repos.memories.remember({ kind: 'fact', scope: 'company:美团', content: '美团网申要扫码登录', source: 'extracted' });
    expect(((await call(deps, 'GET', '/api/career/memories')).json.memories as unknown[]).length).toBe(2);
    expect(((await call(deps, 'GET', '/api/career/memories?q=扫码')).json.memories as Array<{ content: string }>).map(m => m.content)).toEqual(['美团网申要扫码登录']);
    const edited = await call(deps, 'POST', `/api/career/memories/${id}`, { content: '用户希望先说结论，三句话以内', pinned: true });
    expect(edited.json.memory).toMatchObject({ content: '用户希望先说结论，三句话以内', pinned: 1, source: 'user_edit' });
    expect((await call(deps, 'POST', `/api/career/memories/${id}/forget`)).status).toBe(200);
    expect((await call(deps, 'POST', `/api/career/memories/${id}/forget`)).status).toBe(404);
    expect(((await call(deps, 'GET', '/api/career/memories?status=all')).json.memories as unknown[]).length).toBe(2);
  });

  it('个人信息不收：手动加与修改都拒绝', async () => {
    expect((await call(deps, 'POST', '/api/career/memories', { content: '手机 13800138000', kind: 'fact' })).status).toBe(400);
    const id = repos.memories.remember({ kind: 'fact', content: '一条普通记忆', source: 'explicit' }).memory.id;
    expect((await call(deps, 'POST', `/api/career/memories/${id}`, { content: '改成 13800138000' })).status).toBe(400);
    expect((await call(deps, 'POST', '/api/career/memories/mem_missing', { pinned: true })).status).toBe(404);
  });
});
