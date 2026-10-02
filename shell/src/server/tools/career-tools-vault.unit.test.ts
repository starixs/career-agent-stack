import { beforeEach, describe, expect, it, vi } from 'vitest';

// 私密信息库 × career 工具：模型侧永远拿不到明文（vault_status 只有预览 / 占位符；
// 任何工具结果里出现的明文都会被 wrap() 换回占位符；主简历自动写占位符）。

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
const parseResume = (input: unknown) => {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(r[k]) ? r[k] : []);
  return { version: 1, basics: { ...(r.basics as Record<string, unknown> | undefined ?? {}) }, education: arr('education'), experience: arr('experience'), projects: arr('projects'), skills: arr('skills'), awards: arr('awards'), certifications: arr('certifications'), custom_sections: arr('custom_sections') } as never;
};

describe('career 工具 × 私密信息库', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let vault: Vault;

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 5)));
    vault.set({ scope: 'profile', field: 'name', value: '张三' });
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
    vault.set({ scope: 'profile', field: 'school', value: '某某大学' });
    vault.set({ scope: 'site', ref_id: 'zhaopin.com', field: 'password', value: 'Secret#2026' });
    await createCareerServer({ repos, vault, llm: new FakeLLM(), broadcast: () => {}, sessionId: () => 'sess-1', resumeModule: async () => ({ parseResume }) });
  });

  it('vault_status 只返回字段名、脱敏预览与占位符', async () => {
    const res = await call('vault_status');
    expect(res.isError).toBeUndefined();
    const out = res.json() as { profile: { filled: Array<{ field: string; preview: string }>; missing: unknown[] }; sites: Array<{ host: string; hasPassword: boolean }> };
    expect(out.profile.filled.map(f => f.field).sort()).toEqual(['name', 'phone', 'school']);
    expect(out.profile.filled.find(f => f.field === 'phone')?.preview).toBe('138****8000');
    expect(out.sites).toEqual([{ host: 'zhaopin.com', label: null, hasUsername: false, hasPassword: true, autofill: false }]);
    expect(res.text).not.toMatch(/13800138000|Secret#2026/);
    expect(res.text).toContain('{{vault:profile.phone}}');
  });

  it('工具结果里的明文被换回占位符（兜底）', async () => {
    const e = repos.createExperience({ title: '实习', summary: '联系人张三，电话 13800138000，学校 某某大学' });
    const res = await call('experience_list');
    expect(res.text).toContain(e.id);
    expect(res.text).toContain('{{vault:profile.name}}');
    expect(res.text).toContain('{{vault:profile.phone}}');
    expect(res.text).not.toContain('13800138000');
    expect(res.text).toContain('某某大学'); // 非敏感字段允许明文
  });

  it('resume_master_create 自动把姓名 / 手机写成占位符，模型给的明文不覆盖', async () => {
    const res = await call('resume_master_create', { name: '通用版', basics: { name: '李四', email: 'li@x.com' }, draft: false });
    expect(res.isError).toBeUndefined();
    const got = (await call('resume_get')).json() as { resume: { basics: Record<string, string> } };
    expect(got.resume.basics.name).toBe('{{vault:profile.name}}');
    expect(got.resume.basics.phone).toBe('{{vault:profile.phone}}');
    expect(got.resume.basics.email).toBe('li@x.com'); // 私密库没存邮箱，保留用户给的
    const row = repos.db.get<{ schema_json: string }>('SELECT schema_json FROM resume_master')!;
    expect(row.schema_json).not.toContain('张三');
  });
});
