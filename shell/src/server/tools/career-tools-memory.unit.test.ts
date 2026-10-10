import { beforeEach, describe, expect, it, vi } from 'vitest';

// 长期记忆工具：记住 / 取代 / 检索 / 忘掉；个人信息不进记忆。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => {
    mocks.handlers.set(name, handler);
    return { name };
  }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { ...res, text: res.content[0].text, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

describe('career 工具 × 长期记忆', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  const events: Array<{ event: string; data: unknown }> = [];

  beforeEach(async () => {
    mocks.handlers.clear(); events.length = 0;
    repos = createMemoryRepos();
    const vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 5)));
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
    await createCareerServer({ repos, vault, llm: new FakeLLM(), broadcast: (event, data) => { events.push({ event, data }); }, sessionId: () => 'sess-1' });
  });

  it('记住 → 再记一次是加强 → 取代 → 检索 → 忘掉', async () => {
    const a = (await call('memory_remember', { content: '用户希望回复先说结论', kind: 'collaboration' })).json() as { action: string; memory: { id: string } };
    expect(a.action).toBe('created');
    expect(repos.memories.get(a.memory.id)).toMatchObject({ importance: 5, source: 'explicit' });
    expect(events.some(e => e.event === 'career:data-changed' && (e.data as { tables: string[] }).tables.includes('memory'))).toBe(true);
    expect(((await call('memory_remember', { content: '用户希望回复先说结论。', kind: 'collaboration' })).json() as { action: string }).action).toBe('reinforced');
    const b = (await call('memory_remember', { content: '用户希望回复先说结论，三句话以内', kind: 'collaboration', replaces: [a.memory.id] })).json() as { action: string; memory: { id: string } };
    expect(b.action).toBe('superseded');
    const found = (await call('memory_search', { q: '结论' })).json() as { memories: Array<{ id: string }> };
    expect(found.memories.map(m => m.id)).toEqual([b.memory.id]);
    expect((await call('memory_forget', { id: b.memory.id })).isError).toBeUndefined();
    expect((await call('memory_forget', { id: b.memory.id })).isError).toBe(true);
    expect(((await call('memory_search', {})).json() as { memories: unknown[] }).memories).toEqual([]);
  });

  it('个人信息不记成记忆，返回原因', async () => {
    const res = await call('memory_remember', { content: '用户手机号 13800138000', kind: 'fact' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('私密信息');
    expect(res.text).not.toContain('13800138000');
    expect(repos.memories.list()).toEqual([]);
  });
});
