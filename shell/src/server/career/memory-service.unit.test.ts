import { describe, expect, it } from 'vitest';
import { extractJson, type LLM } from '@career/core';

import { buildCareerContextReminder } from '../../shared/systemReminder';
import { applyRemember, buildMemoryContext, extractMemories, memoryQueueIdle, onTurnStop, onUserPrompt, parseTurn, turnScopes } from './memory-service';
import { createMemoryRepos } from './test-db';

const vault = { redact: (s: string) => s.replace(/13812345678/g, '{{vault:profile.phone}}').replace(/张三/g, '{{vault:profile.name}}') };
const fakeLLM = (reply: unknown): LLM & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, complete: async req => { calls.push(String(req.messages[0].content)); return { text: JSON.stringify(reply) } as never; } };
};

function seedApplication(repos: ReturnType<typeof createMemoryRepos>, company = '美团') {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${company}`, title: 'AI 应用开发', company_name: company, url: 'https://x' });
  return { job, app: repos.createApplication(job.id) };
}

describe('parseTurn / turnScopes', () => {
  it('系统插轮（心跳 / 记忆巩固）不是真人输入；面板消息是，带出对象 id', () => {
    expect(parseTurn('<system-reminder>\n<HEARTBEAT>check</HEARTBEAT>\n</system-reminder>').human).toBe(false);
    expect(parseTurn('帮我看看美团').human).toBe(true);
    const panel = `${buildCareerContextReminder({ surface: 'apply', refs: { application_id: 'app_1' } })}\n\n投这个`;
    expect(parseTurn(panel)).toMatchObject({ human: true, visible: '投这个', refs: { application_id: 'app_1' } });
  });

  it('scope：投递 id → 投递 + 公司；消息里出现的已知公司名', () => {
    const repos = createMemoryRepos();
    const { app } = seedApplication(repos);
    seedApplication(repos, '字节跳动');
    expect(turnScopes(repos, { visible: '投这个', human: true, refs: { application_id: app.id } }).sort()).toEqual([`application:${app.id}`, 'company:美团'].sort());
    expect(turnScopes(repos, { visible: '字节跳动那边怎么样', human: true, refs: {} })).toEqual(['company:字节跳动']);
  });
});

describe('buildMemoryContext', () => {
  it('注入全局 + 本轮公司的记忆，不串到别家；系统插轮不注入', () => {
    const repos = createMemoryRepos();
    seedApplication(repos); seedApplication(repos, '字节跳动');
    repos.memories.remember({ kind: 'collaboration', content: '用户希望回复先说结论', source: 'explicit' });
    repos.memories.remember({ kind: 'fact', scope: 'company:美团', content: '美团网申要微信扫码登录', source: 'extracted' });
    repos.memories.remember({ kind: 'fact', scope: 'company:字节跳动', content: '字节一面问了 Transformer', source: 'extracted' });
    const ctx = buildMemoryContext(repos, '美团的网申怎么弄')!;
    expect(ctx).toContain('先说结论');
    expect(ctx).toContain('微信扫码');
    expect(ctx).not.toContain('Transformer');
    expect(ctx).toContain('以用户为准');
    expect(buildMemoryContext(repos, '<system-reminder>\n<HEARTBEAT>x</HEARTBEAT>\n</system-reminder>')).toBeUndefined();
    expect(buildMemoryContext(createMemoryRepos(), '你好')).toBeUndefined();
  });
});

describe('applyRemember（把关）', () => {
  it('私密信息不进记忆；公司名对不上降回 user；supersedes 只认同 scope 的有效记忆', () => {
    const repos = createMemoryRepos();
    expect(applyRemember(repos, vault, { kind: 'fact', content: '用户手机号是 13812345678', source: 'explicit' })).toMatchObject({ ok: false });
    expect(applyRemember(repos, vault, { kind: 'nope', content: 'x', source: 'explicit' })).toMatchObject({ ok: false });
    const a = applyRemember(repos, vault, { kind: 'fact', scope: 'company:腾讯', content: '面试官很看重算法', source: 'extracted' }, { companies: ['美团'] });
    expect(a.ok && a.memory.scope).toBe('user');
    const old = applyRemember(repos, vault, { kind: 'preference', content: '用户不考虑外包', source: 'explicit' });
    const next = applyRemember(repos, vault, { kind: 'preference', content: '用户可以接受驻场外包，但不接受劳务派遣', supersedes: [old.ok ? old.memory.id : '', 'mem_missing'], source: 'explicit' });
    expect(next).toMatchObject({ ok: true, action: 'superseded' });
    expect(repos.memories.list().map(m => m.content).sort()).toEqual(['用户可以接受驻场外包，但不接受劳务派遣', '面试官很看重算法'].sort());
  });
});

describe('extractMemories', () => {
  it('候选按规则落库：转走的不记、私密的丢弃、最多 3 条、取代与忘掉只认已有 id；送给模型的文本已脱敏', async () => {
    const repos = createMemoryRepos();
    seedApplication(repos);
    const stale = repos.memories.remember({ kind: 'collaboration', content: '用户希望回复越详细越好', source: 'extracted' }).memory;
    const wrong = repos.memories.remember({ kind: 'fact', scope: 'company:美团', content: '美团不用登录', source: 'extracted' }).memory;
    const llm = fakeLLM({
      memories: [
        { kind: 'collaboration', scope: 'user', content: '用户希望回复先说结论，别太长', importance: 5, supersedes: stale.id, route: null },
        { kind: 'fact', scope: 'company:美团', content: '美团网申要微信扫码登录', importance: 2, route: null },
        { kind: 'preference', content: '期望城市上海', route: 'job_prefs' },
        { kind: 'fact', content: '用户叫张三', route: null },
        { kind: 'insight', content: '用户一紧张就语速太快', route: null },
        { kind: 'insight', content: '第四条有效候选不该写', route: null },
      ],
      forget: [wrong.id, 'mem_not_mine'],
    });
    const out = await extractMemories({ repos, vault, llm, systemPrompt: async () => 'sys', extractJson }, { userText: '我是张三，电话 13812345678。以后回复先说结论别太长。美团要扫码登录', assistantText: '好的' });
    expect(llm.calls[0]).not.toContain('13812345678');
    expect(llm.calls[0]).not.toContain('张三');
    expect(out).toMatchObject({ routed: 1, dropped: 2, forgotten: [wrong.id] });
    expect(out.written.map(w => w.ok && w.action)).toEqual(['superseded', 'created', 'created']);
    const active = repos.memories.list();
    expect(active.map(m => m.content).sort()).toEqual(['用户希望回复先说结论，别太长', '美团网申要微信扫码登录', '用户一紧张就语速太快'].sort());
    // 自动提炼的重要度封顶 4（5 只留给用户明确要求）
    expect(active.find(m => m.kind === 'collaboration')!.importance).toBe(4);
  });
});

describe('hook 编排', () => {
  it('UserPromptSubmit 记下真人原话 → Stop 排队提炼；系统插轮与子代理不提炼', async () => {
    const repos = createMemoryRepos();
    repos.memories.remember({ kind: 'collaboration', content: '用户希望回复先说结论', source: 'explicit' });
    const ctx = await onUserPrompt({ session_id: 's1', prompt: '帮我改简历', prompt_id: 'p1' }, async () => repos);
    expect(ctx).toContain('先说结论');
    const seen: Array<{ userText: string; sourceRef?: string }> = [];
    onTurnStop({ session_id: 's1', last_assistant_message: '改好了' }, async t => { seen.push(t); });
    await onUserPrompt({ session_id: 's1', prompt: '<system-reminder>\n<HEARTBEAT>x</HEARTBEAT>\n</system-reminder>' }, async () => repos);
    onTurnStop({ session_id: 's1', last_assistant_message: 'HEARTBEAT_OK' }, async t => { seen.push(t); });
    onTurnStop({ session_id: 's1', last_assistant_message: 'x', agent_id: 'sub' }, async t => { seen.push(t); });
    await memoryQueueIdle();
    expect(seen).toEqual([{ userText: '帮我改简历', assistantText: '改好了', sourceRef: 'prompt:p1' }]);
  });
});
