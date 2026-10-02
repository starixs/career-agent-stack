import { beforeEach, describe, expect, it, vi } from 'vitest';

// 简历工具：主简历的创建 / 读取 / 保存，以及 resume_tailor 自动解析唯一主简历。
// SDK 的 tool() 被替换成注册表，直接调用 handler；模型用 FakeLLM；数据层用内存 SQLite。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

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
import { createCareerServer } from './career-tools';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { ...res, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

/** 轻量 schema：只保证各分区是数组、basics 是对象（真实实现在 @career/resume，这里不拉 react-pdf）。 */
const parseResume = (input: unknown) => {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(r[k]) ? r[k] : []);
  return { version: 1, basics: { ...(r.basics as Record<string, unknown> | undefined ?? {}) }, education: arr('education'), experience: arr('experience'), projects: arr('projects'), skills: arr('skills'), awards: arr('awards'), certifications: arr('certifications'), custom_sections: arr('custom_sections') } as never;
};

describe('career 简历工具', () => {
  let llm: FakeLLM;
  let events: Array<{ event: string; data: unknown }>;
  let repos: ReturnType<typeof createMemoryRepos>;

  beforeEach(async () => {
    mocks.handlers.clear();
    llm = new FakeLLM();
    events = [];
    repos = createMemoryRepos();
    await createCareerServer({
      repos, llm, broadcast: (event, data) => events.push({ event, data }), sessionId: () => 'sess-1',
      resumeModule: async () => ({ parseResume }),
    });
  });

  it('注册了主简历工具，resume_tailor 的 master_id 变为可选', () => {
    for (const name of ['resume_list', 'resume_master_create', 'resume_get', 'resume_save', 'resume_tailor', 'resume_confirm', 'resume_export']) {
      expect(mocks.handlers.has(name), name).toBe(true);
    }
  });

  it('没有主简历时 resume_tailor 明确提示先调用 resume_master_create', async () => {
    const res = await call('resume_tailor', { job_id: 'job_x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('resume_master_create');
    expect(llm.calls).toHaveLength(0);
  });

  it('经历库为空时创建只含基本信息的空壳主简历，不调模型', async () => {
    const res = await call('resume_master_create', { name: '通用版', basics: { name: '张三', email: 'z@x.com' } });
    expect(res.isError).toBeUndefined();
    const out = res.json();
    expect(out.drafted).toBe(false);
    expect(out.confirmed_claims).toBe(0);
    expect(String(out.note)).toContain('经历库');
    expect(llm.calls).toHaveLength(0);

    const got = (await call('resume_get')).json();
    expect(got.id).toBe(out.master_id);
    expect((got.resume as { basics: { name: string } }).basics.name).toBe('张三');
    expect(events.some(e => e.event === 'career:data-changed' && (e.data as { tables: string[] }).tables.includes('resume_master'))).toBe(true);
  });

  it('有已确认主张时用 resume-draft 技能起草，用户给的 basics 优先于模型输出', async () => {
    const exp = repos.createExperience({ title: '数据分析实习', org: '某公司', role: '实习生', type: 'data', start_date: '2024-07', end_date: '2024-09' });
    const confirmed = repos.addClaim({ experience_id: exp.id, text: '搭建周报看板', result_metric: '节省 3 小时/周', created_from: 'interview' });
    repos.confirmClaim(confirmed.id);
    repos.addClaim({ experience_id: exp.id, text: '待确认的主张', created_from: 'interview' });

    llm.push((req) => {
      expect(req.system).toContain('# 技能：resume-draft');
      expect(req.messages[0].content).toContain('搭建周报看板');
      expect(req.messages[0].content).not.toContain('待确认的主张');
      return JSON.stringify({
        resume: { basics: { name: '模型猜的名字', city: '上海' }, experience: [{ org: '某公司', position: '数据分析实习生', start: '2024.07', end: '2024.09', bullets: ['搭建周报看板，节省 3 小时/周'], claim_ids: [confirmed.id] }] },
        used_claim_ids: [confirmed.id], missing: [{ field: 'basics.phone', why: '用户未提供' }], notes: '',
      });
    });

    const out = (await call('resume_master_create', { direction: '数据分析', basics: { name: '李四' } })).json();
    expect(out.drafted).toBe(true);
    expect(out.confirmed_claims).toBe(1);
    expect((out.master as { name: string; direction: string }).name).toBe('数据分析方向');
    expect(out.missing).toEqual([{ field: 'basics.phone', why: '用户未提供' }]);

    const resume = (await call('resume_get', { resume_id: out.master_id })).json().resume as { basics: Record<string, string>; experience: Array<{ claim_ids: string[] }> };
    expect(resume.basics.name).toBe('李四');
    expect(resume.basics.city).toBe('上海');
    expect(resume.experience[0].claim_ids).toEqual([confirmed.id]);

    const list = (await call('resume_list')).json();
    expect((list.masters as Array<{ id: string; experience: number }>).map(m => ({ id: m.id, experience: m.experience }))).toEqual([{ id: out.master_id, experience: 1 }]);
  });

  it('resume_save 支持 JSON Patch，覆盖前写快照；多份主简历时要求指定 id', async () => {
    const a = (await call('resume_master_create', { name: 'A', basics: { name: '张三' } })).json();
    const saved = (await call('resume_save', { resume_id: a.master_id, patch: [{ op: 'replace', path: '/basics/email', value: 'new@x.com' }], note: '补邮箱' })).json();
    expect(saved.applied_ops).toBe(1);
    expect((saved.resume as { basics: Record<string, string> }).basics).toEqual({ name: '张三', email: 'new@x.com' });
    const snapshots = repos.db.all<{ note: string }>('SELECT note FROM resume_snapshot WHERE resume_id=?', [a.master_id as string]);
    expect(snapshots.map(s => s.note)).toEqual(['补邮箱']);

    await call('resume_master_create', { name: 'B' });
    const res = await call('resume_save', { patch: [{ op: 'replace', path: '/basics/city', value: '北京' }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('resume_list');

    const bad = await call('resume_save', { resume_id: a.master_id });
    expect(bad.isError).toBe(true);
  });
});
