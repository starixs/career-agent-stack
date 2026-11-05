import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCareerRoute } from '../routes/career';
import { fireUsageMeterHook, setUsageMeterHook } from '../turn-hooks';
import { flushBillingWrites, installBillingMeter } from './billing-service';
import { setRepos } from './db';
import { ShellLLM } from './llm';
import { meteredSearch } from './search';
import { createMemoryRepos } from './test-db';

const env = {
  providerId: 'career-llm',
  providerName: '内置求职模型',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-test',
  authType: 'auth_token' as const,
  modelAliases: { sonnet: 'deepseek-flash' },
};

let repos = createMemoryRepos();
const usageRows = () => repos.db.all<{ name: string; origin: string; kind: string; cache_read_tokens: number; idempotency_key: string }>('SELECT * FROM billing_usage ORDER BY created_at');

beforeEach(() => {
  repos = createMemoryRepos();
  setRepos(repos);
  installBillingMeter();
});
afterEach(() => {
  setUsageMeterHook(null);
  setRepos(null);
});

describe('计费埋点', () => {
  it('主对话一轮的用量进账本；同一轮重报不重复记', async () => {
    const turn = { key: 'chat:s1:r1', scope: 'chat:s1', origin: 'chat' as const, model: 'deepseek-flash', inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 1_000_000 };
    fireUsageMeterHook(turn);
    fireUsageMeterHook(turn);
    await flushBillingWrites();
    expect(usageRows()).toEqual([expect.objectContaining({ name: 'deepseek-v4-flash', origin: 'chat', cache_read_tokens: 1_000_000 })]);
    // (10万×5 + 2万×10 + 100万×0.1) / 1e6 × 7 = 5.6 → 扣 6
    const txn = repos.db.get<{ amount: number }>("SELECT amount FROM credit_transaction WHERE type='spend'");
    expect(txn?.amount).toBe(-6);
  });

  it('什么都没花的调用不记', async () => {
    fireUsageMeterHook({ key: 'chat:s1:empty', origin: 'chat', inputTokens: 0, outputTokens: 0 });
    await flushBillingWrites();
    expect(usageRows()).toHaveLength(0);
  });

  it('后台模型调用记成 background，并带上 DeepSeek 返回的缓存命中', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek-flash', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 4000 },
    }), { status: 200 }));
    const llm = new ShellLLM({ providerId: 'career-llm', resolveEnv: () => env, fetchImpl });
    await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    await flushBillingWrites();
    expect(usageRows()).toEqual([expect.objectContaining({ origin: 'background', kind: 'llm', name: 'deepseek-v4-flash', cache_read_tokens: 4000 })]);
  });

  it('联网搜索按次记；搜失败不记', async () => {
    const ok = meteredSearch({ name: 'bocha', search: async () => [{ title: 't', url: 'u', snippet: 's' }] });
    await ok.search('字节跳动 校招');
    const bad = meteredSearch({ name: 'tavily', search: async () => { throw new Error('quota'); } });
    await expect(bad.search('x')).rejects.toThrow('quota');
    await flushBillingWrites();
    expect(usageRows()).toEqual([expect.objectContaining({ kind: 'tool', name: 'search:bocha' })]);
  });

  it('账本写失败只留日志，不往外抛', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    repos.db.raw.exec('DROP TABLE billing_usage');
    fireUsageMeterHook({ key: 'chat:s1:r9', origin: 'chat', model: 'deepseek-flash', inputTokens: 10, outputTokens: 10 });
    await flushBillingWrites();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[billing] FAILED kind=llm key=chat:s1:r9'));
    error.mockRestore();
  });
});

describe('/api/career/billing', () => {
  const call = async (method: string, action: string) => {
    const res = await handleCareerRoute(`/api/career/billing/${action}`, new Request(`http://localhost/api/career/billing/${action}`, { method }), { repos });
    if (!res) throw new Error('路由没有接住');
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  it('summary / price-list / checkin / transactions', async () => {
    const summary = await call('GET', 'summary');
    expect(summary.body).toMatchObject({ ok: true, summary: { balance: 50 } });
    const list = await call('GET', 'price-list');
    expect(list.body.priceList).toMatchObject({ creditUnitPriceCents: 20, llmMarginMultiplier: 7 });
    const first = await call('POST', 'checkin');
    expect(first.body.checkin).toMatchObject({ granted: true, credits: 2, balance: 52 });
    expect((await call('POST', 'checkin')).body.checkin).toMatchObject({ granted: false });
    const txns = await call('GET', 'transactions');
    expect((txns.body.transactions as unknown[]).length).toBe(2);
    expect((await call('GET', 'nope')).status).toBe(404);
  });
});
