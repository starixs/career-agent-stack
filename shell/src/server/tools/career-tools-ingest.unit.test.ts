import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 冷启动：用户把手里的简历 PDF 拖进对话，ingest_document 把它收进经历库。
// 读取走对话附件同一套（这里注入），不再依赖没随产品打包的 docparse。

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

import { FakeLLM } from '@career/core';

import { createMemoryRepos } from '../career/test-db';
import { configureCareerTools, createCareerServer } from './career-tools';

const call = (name: string, args: Record<string, unknown>) => mocks.handlers.get(name)!(args);

describe('ingest_document · 拖进来的简历', () => {
  let workspace: string;
  let llm: FakeLLM;
  let repos: ReturnType<typeof createMemoryRepos>;
  let reads: string[];
  let readResult: { ok: boolean; text: string; attempts: string[] };

  beforeEach(async () => {
    mocks.handlers.clear();
    workspace = mkdtempSync(join(tmpdir(), 'career-ingest-'));
    writeFileSync(join(workspace, '张三-简历.pdf'), '%PDF-1.4');
    configureCareerTools({}, { sessionId: 'sess-1', workspace });
    llm = new FakeLLM();
    repos = createMemoryRepos();
    reads = [];
    readResult = { ok: true, text: '张三 北京大学 2026 届\n美团 数据分析实习：搭建日报看板，周会准备时间从 3 小时降到 30 分钟', attempts: [] };
    await createCareerServer({
      repos, llm, broadcast: () => undefined, sessionId: () => 'sess-1',
      readDocument: async abs => { reads.push(abs); return readResult; },
    });
  });
  afterEach(() => { configureCareerTools({}, { sessionId: 'default' }); rmSync(workspace, { recursive: true, force: true }); });

  it('对话附件给的工作区相对路径能读，抽出的主张进经历库且都待确认', async () => {
    llm.push(JSON.stringify({ claims: [{ text: '在美团搭建日报看板，周会准备时间从 3 小时降到 30 分钟', attribution: 'self', result_metric: '3 小时 → 30 分钟', excerpt: '周会准备时间从 3 小时降到 30 分钟' }] }));
    const res = await call('ingest_document', { path: '张三-简历.pdf' });
    expect(res.isError).toBeUndefined();
    expect(reads).toEqual([join(workspace, '张三-简历.pdf')]);
    expect(repos.listExperiences()).toHaveLength(1);
    expect(repos.listClaims().map(c => c.status)).toEqual(['pending']);
  });

  it('读不出文字时如实说明尝试过什么，不建空经历', async () => {
    readResult = { ok: false, text: '', attempts: ['AnyDoc：服务未启动', 'PDF 文本层：没有识别出任何文字'] };
    const res = await call('ingest_document', { path: '张三-简历.pdf' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('PDF 文本层');
    expect(repos.listExperiences()).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('文件不存在时直接报错', async () => {
    const res = await call('ingest_document', { path: '不存在.pdf' });
    expect(res.isError).toBe(true);
    expect(reads).toEqual([]);
  });
});
