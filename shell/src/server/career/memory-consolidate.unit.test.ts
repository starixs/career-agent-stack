import { describe, expect, it } from 'vitest';
import { extractJson, type LLM } from '@career/core';

import { consolidateMemories, mergeCandidates, similarity } from './memory-consolidate';
import { createMemoryRepos } from './test-db';

const llmReplying = (reply: (prompt: string) => unknown): LLM & { calls: number } => {
  const llm = { calls: 0, complete: async (req: { messages: Array<{ content: unknown }> }) => { llm.calls++; return { text: JSON.stringify(reply(String(req.messages[0].content))) } as never; } };
  return llm as unknown as LLM & { calls: number };
};

describe('mergeCandidates', () => {
  it('同 scope 同类型且文字相近才成组；置顶 / 用户手改的不参与', () => {
    const repos = createMemoryRepos();
    const m = repos.memories;
    m.remember({ kind: 'collaboration', content: '用户希望回复先说结论', source: 'extracted' });
    m.remember({ kind: 'collaboration', content: '用户希望回复先说结论再说依据', source: 'extracted' });
    m.remember({ kind: 'preference', content: '用户希望回复先说结论再给理由', source: 'extracted' }); // 类型不同
    m.remember({ kind: 'collaboration', scope: 'company:美团', content: '用户希望回复先说结论', source: 'extracted' }); // scope 不同
    m.remember({ kind: 'collaboration', content: '用户不喜欢被称呼为您', source: 'extracted' }); // 不相近
    const pinned = m.remember({ kind: 'collaboration', content: '用户希望回复先说结论并且简短', source: 'explicit', pinned: true }).memory;
    const groups = mergeCandidates(m.list({ limit: 100 }));
    expect(groups).toHaveLength(1);
    expect(groups[0].map(r => r.content).sort()).toEqual(['用户希望回复先说结论', '用户希望回复先说结论再说依据']);
    expect(groups[0].some(r => r.id === pinned.id)).toBe(false);
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('ab', 'cd')).toBe(0);
  });
});

describe('consolidateMemories', () => {
  it('衰减 + 合并：模型说合并就取代旧条；乱给的 id / 过长 / 含私密信息的合并被代码挡下；24 小时内不重跑', async () => {
    const repos = createMemoryRepos();
    const m = repos.memories;
    const a = m.remember({ kind: 'collaboration', content: '用户希望回复先说结论', source: 'extracted', importance: 2 }).memory;
    const b = m.remember({ kind: 'collaboration', content: '用户希望回复先说结论再说依据', source: 'extracted', importance: 3 }).memory;
    const c = m.remember({ kind: 'preference', content: '用户不考虑外包岗位', source: 'extracted' }).memory;
    const d = m.remember({ kind: 'preference', content: '用户不考虑外包类岗位', source: 'extracted' }).memory;
    const llm = llmReplying(() => ({ groups: [
      { ids: [a.id, b.id], action: 'merge', content: '用户希望回复先说结论，再给依据' },
      { ids: [c.id, d.id], action: 'merge', content: '用户电话 13812345678 不考虑外包' },
      { ids: [a.id, 'mem_fake'], action: 'merge', content: '伪造' },
    ] }));
    const vault = { redact: (s: string) => s.replace('13812345678', '{{vault:profile.phone}}') };
    const at = new Date();
    const r = await consolidateMemories({ repos, vault, llm, systemPrompt: async () => 'sys', extractJson, now: () => at });
    expect(r).toMatchObject({ merged: 1, groups: 2 });
    expect(m.get(a.id)?.status).toBe('superseded');
    const merged = m.list().find(x => x.source === 'consolidation')!;
    expect(merged).toMatchObject({ content: '用户希望回复先说结论，再给依据', importance: 3, kind: 'collaboration' });
    expect(m.get(c.id)?.status).toBe('active');
    const again = await consolidateMemories({ repos, vault, llm, systemPrompt: async () => 'sys', extractJson, now: () => new Date(at.getTime() + 3_600_000) });
    expect(again.skipped).toBe('recent');
    expect(llm.calls).toBe(1);
  });

  it('没有模型时只做衰减，不报错', async () => {
    const repos = createMemoryRepos();
    repos.memories.remember({ kind: 'fact', content: '很久以前的一件事', source: 'extracted' });
    const r = await consolidateMemories({ repos, vault: null, llm: null, systemPrompt: async () => '', extractJson, now: () => new Date(Date.now() + 40 * 86_400_000) });
    expect(r).toMatchObject({ decayed: 1, merged: 0 });
  });
});
