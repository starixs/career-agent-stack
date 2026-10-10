import { beforeEach, describe, expect, it, vi } from 'vitest';

// 模型浏览工具：观察 / 回执排成模型好用的文字；用户接管中给明确提示；提交类按钮的回执指向投递流程。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _d: string, _s: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await mocks.handlers.get(name)!(args);
  return { ...res, text: res.content[0].text };
};

const observation = {
  observation_id: 'o1', url: 'https://zhaopin.meituan.com/job/1', title: '职位详情', scroll: { y: 0, max: 1200, viewport: 768 },
  elements: [
    { ref: 1, kind: 'link', text: '返回列表', href: 'https://zhaopin.meituan.com/list' },
    { ref: 2, kind: 'button', text: '立即投递', guarded: 'submit' },
    { ref: 3, kind: 'input', text: '密码', guarded: 'password' },
  ],
  more_elements: 12, text: '岗位职责：负责大模型应用开发', text_total: 3200, hints: ['login', 'submit_page'],
  tabs: [{ index: 0, title: '职位详情', url: 'https://zhaopin.meituan.com/job/1', active: true }, { index: 1, title: '列表', url: 'x', active: false }],
};

describe('career 浏览工具', () => {
  const runs: Array<Record<string, unknown>> = [];
  let reply: (body: Record<string, unknown>) => Array<Record<string, unknown>> = () => [];
  beforeEach(async () => {
    mocks.handlers.clear(); runs.length = 0;
    await createCareerServer({
      repos: createMemoryRepos(), llm: new FakeLLM(), broadcast: () => {}, sessionId: () => 's1',
      browserRun: async (body: Record<string, unknown>, onEvent: (ev: Record<string, unknown>) => void) => { runs.push(body); for (const ev of reply(body)) onEvent(ev); },
    } as never);
  });

  it('observe：编号清单、提交类与密码框标注、提示与标签页', async () => {
    reply = () => [{ type: 'result', op: 'browse', action: 'observe', observation }];
    const res = await call('browser_observe');
    expect(runs[0]).toMatchObject({ op: 'browse', action: 'observe' });
    expect(res.text).toContain('观察 o1 · 职位详情');
    expect(res.text).toContain('[1] link 返回列表 → https://zhaopin.meituan.com/list');
    expect(res.text).toContain('[2] button 立即投递 ⛔提交类，不能点');
    expect(res.text).toContain('🔒密码框，只能填占位符');
    expect(res.text).toContain('需要登录');
    expect(res.text).toContain('[0*] 职位详情');
    expect(res.text).toContain('还有 12 个元素');
    expect(res.text).toContain('完整内容用 browser_read');
  });

  it('act：提交类被拦的回执指向投递流程；带观察编号转发', async () => {
    reply = () => [{ type: 'result', op: 'browse', action: 'act', receipt: { ok: false, observed_effect: 'no_change', retryable: false, required_next: 'apply_flow', code: 'submit_guarded', note: '「立即投递」是提交 / 投递类按钮', new_tabs: [] } }];
    const res = await call('browser_act', { action: 'click', observation_id: 'o1', ref: 2 });
    expect(runs[0]).toMatchObject({ op: 'browse', action: 'act', act: { action: 'click', observation_id: 'o1', ref: 2 } });
    expect(res.text).toContain('不要重复这个操作');
    expect(res.text).toContain('browser_capture_job 收录岗位 → apply_prepare');
  });

  it('用户接管中（409）：明确让模型等用户交回', async () => {
    const server = await createCareerServer({
      repos: createMemoryRepos(), llm: new FakeLLM(), broadcast: () => {}, sessionId: () => 's1',
      browserRun: async () => { throw new Error('浏览器 run 请求失败（HTTP 409）'); },
    } as never);
    void server;
    const res = await call('browser_observe');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('用户正在接管浏览器');
  });
});
