import { beforeEach, describe, expect, it, vi } from 'vitest';

// 对话内流程卡片（SSE career:card）：工具在"需要用户动手"的节点推卡片，用户在卡片里完成，
// 值走产品接口落库（私密信息进私密库），不经过模型。

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { RunRegistry } from '../career/runs';
import { createMemoryRepos } from '../career/test-db';
import { handleCareerRoute } from '../routes/career';
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

interface CardEvent { sessionId: string; card: { id: string; kind: string; title: string; data: Record<string, unknown> } }

describe('对话内流程卡片', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let vault: Vault;
  let llm: FakeLLM;
  let events: Array<{ event: string; data: unknown }>;
  let script: Array<Record<string, unknown>>;
  const cards = () => events.filter(e => e.event === 'career:card').map(e => e.data as CardEvent);

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 3)));
    llm = new FakeLLM();
    events = []; script = [];
    const broadcast = (event: string, data: unknown) => { events.push({ event, data }); };
    await createCareerServer({
      repos, vault, llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'),
      resumeModule: async () => ({ parseResume }),
      browserRun: async (_body, onEvent) => { for (const ev of script) onEvent(ev); },
    });
  });

  it('vault_status：缺核心资料时推「补齐基本信息」卡片，只有字段名、没有值', async () => {
    vault.set({ scope: 'profile', field: 'name', value: '张三' });
    vault.set({ scope: 'profile', field: 'phone', value: '13800138000' });
    await call('vault_status');
    const [c] = cards();
    expect(c).toMatchObject({ sessionId: 'sess-1', card: { id: 'vault_missing', kind: 'vault_missing' } });
    const fields = (c.card.data.fields as Array<{ field: string }>).map(f => f.field);
    expect(fields).toEqual(['email', 'school', 'major', 'degree', 'graduation']);
    expect(JSON.stringify(c)).not.toMatch(/张三|13800138000/);

    for (const f of fields) vault.set({ scope: 'profile', field: f, value: 'x' });
    events = [];
    await call('vault_status');
    expect(cards()).toHaveLength(0);
  });

  it('experience_add：带主张时推「确认说法」卡片', async () => {
    const out = (await call('experience_add', { title: '字节实习', claims: [{ text: '主导召回重构', result_metric: 'CTR +3%' }, { text: '带 3 人小组', attribution: 'team' }] })).json();
    const [c] = cards();
    const experience = out.experience as { id: string };
    expect(c.card).toMatchObject({ id: `claims:${experience.id}`, kind: 'claims_confirm', data: { experience_title: '字节实习' } });
    expect((c.card.data.claims as Array<{ text: string; result_metric: string | null }>).map(x => [x.text, x.result_metric])).toEqual([['主导召回重构', 'CTR +3%'], ['带 3 人小组', null]]);
  });

  it('apply_run：需要用户填的项 → needs_user 卡（资料字段标记写私密库），开放题 → drafts 卡', async () => {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j1', title: '算法实习生', company_name: 'B 公司', url: 'https://x.com/apply' });
    const app = repos.createApplication(job.id);
    repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url, application_id: app.id }, app.id);
    repos.reviewActions([action.id], 'approved');
    script = [{ type: 'result', op: 'drive', result: {
      status: 'stopped_before_submit', message: 'ok', finalUrl: 'https://x.com/apply/2', adapterId: 'generic', filled: [],
      needsUser: [{ fieldId: 'f1', label: '身份证号', key: 'idNumber', status: 'needs_user', source: 'none', confidence: 0 }, { fieldId: 'f2', label: '期望薪资', status: 'needs_user', source: 'none', confidence: 0, note: '月薪' }],
      drafts: [{ fieldId: 'f3', label: '为什么选择我们', value: '因为……', status: 'draft_needs_confirm', source: 'draft', confidence: 0.6 }],
      mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'],
    } }];
    await call('apply_run', { action_id: action.id });
    const byKind = Object.fromEntries(cards().map(c => [c.card.kind, c.card]));
    expect(byKind.needs_user).toMatchObject({ id: `needs_user:${action.id}`, data: { action_id: action.id } });
    expect(byKind.needs_user.data.items).toEqual([
      { label: '身份证号', note: null, vault_field: 'idNumber', sensitive: true },
      { label: '期望薪资', note: '月薪', vault_field: null, sensitive: false },
    ]);
    expect(byKind.drafts.data.items).toEqual([{ label: '为什么选择我们', value: '因为……', note: null }]);
  });

  it('resume_tailor：推「简历改动」卡片；卡片的确认接口只应用勾选的路径', async () => {
    const master = (await call('resume_master_create', { name: '主简历', basics: { name: '张三' } })).json();
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '甲公司', jd_raw: 'JD', jd_parsed_json: JSON.stringify({ title: '数据分析', keywords: ['SQL'] }) });
    llm.push(() => JSON.stringify({
      patch: [{ op: 'add', path: '/basics/summary', value: '熟悉 SQL' }, { op: 'add', path: '/basics/city', value: '上海' }],
      reasons: [{ path: '/basics/summary', reason: '对齐 JD 关键词 SQL' }],
      unresolved: ['想补 Kafka'],
    }));
    const out = (await call('resume_tailor', { master_id: master.master_id, job_id: job.id })).json();
    const c = cards().find(x => x.card.kind === 'resume_diff')!;
    expect(c.card).toMatchObject({ id: `resume_diff:${out.tailored_id}`, title: '为「数据分析」定制简历：2 处改动', data: { tailored_id: out.tailored_id, unresolved: ['想补 Kafka'] } });
    expect(c.card.data.ops).toEqual([
      { op: 'add', path: '/basics/summary', value: '熟悉 SQL', reason: '对齐 JD 关键词 SQL' },
      { op: 'add', path: '/basics/city', value: '上海', reason: null },
    ]);

    const request = new Request(`http://local/api/career/resumes/${String(out.tailored_id)}/confirm`, { method: 'POST', body: JSON.stringify({ accepted_paths: ['/basics/summary'] }), headers: { 'Content-Type': 'application/json' } });
    const routeEvents: string[] = [];
    const res = await handleCareerRoute(new URL(request.url).pathname, request, { repos, vault, llm: null, broadcast: (e) => { routeEvents.push(e); }, sessionId: () => 'sess-1' });
    const body = await res!.json() as { ok: boolean; applied_ops: number };
    expect(body).toMatchObject({ ok: true, applied_ops: 1 });
    const resume = (await call('resume_get', { resume_id: out.tailored_id })).json().resume as { basics: Record<string, string> };
    expect(resume.basics).toMatchObject({ name: '张三', summary: '熟悉 SQL' });
    expect(resume.basics.city).toBeUndefined();
    expect(routeEvents).toContain('career:data-changed');

    const missing = await handleCareerRoute('/api/career/resumes/nope/confirm', new Request('http://local/api/career/resumes/nope/confirm', { method: 'POST', body: '{}' }), { repos, vault, llm: null, broadcast: () => {}, sessionId: () => 's' });
    expect(missing!.status).toBe(404);
  });

  it('apply_run 卡在登录页且没存账号 → site_login 卡；已存密码则不推', async () => {
    const job = repos.upsertJob({ source_platform: 'campus', source_job_id: 'j2', title: '后端', company_name: 'C 公司', url: 'https://www.campus.example.com/apply' });
    const action = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url }, null);
    repos.reviewActions([action.id], 'approved');
    script = [{ type: 'result', op: 'drive', result: { status: 'handoff', reason: 'login', message: '需要登录', userAction: '请登录', finalUrl: 'https://www.campus.example.com/login', adapterId: 'generic', filled: [], needsUser: [], drafts: [], mismatches: [], uploads: [], escalations: [], layersUsed: ['dom'] } }];
    await call('apply_run', { action_id: action.id });
    expect(cards().find(c => c.card.kind === 'site_login')?.card).toMatchObject({ id: 'site_login:campus.example.com', data: { host: 'campus.example.com', has_username: false } });

    vault.set({ scope: 'site', ref_id: 'campus.example.com', field: 'password', value: 'pw' });
    events = [];
    const again = repos.enqueueAction('fill_form', { job_id: job.id, url: job.url }, null);
    repos.reviewActions([again.id], 'approved');
    await call('apply_run', { action_id: again.id });
    expect(cards().some(c => c.card.kind === 'site_login')).toBe(false);
  });

  it('mail_accounts：没绑定邮箱时推「绑定邮箱」卡片', async () => {
    await call('mail_accounts');
    const c = cards().find(x => x.card.kind === 'mail_bind');
    expect(c?.card.id).toBe('mail_bind');
    expect((c?.card.data.presets as unknown[]).length).toBeGreaterThan(0);
  });

  it('ui_open：简历编辑器在聊天旁打开并定位；不存在的 id 报错；live 打开现场抽屉；其余打开一级面板', async () => {
    const master = (await call('resume_master_create', { name: '主简历', basics: { name: '张三' } })).json();
    events = [];
    const opened = (await call('ui_open', { target: 'resume_editor' })).json();
    expect(opened).toMatchObject({ opened: 'resume_editor', resume_id: master.master_id });
    expect(events.find(e => e.event === 'career:focus')?.data).toMatchObject({ sessionId: 'sess-1', surface: 'resume_editor', id: master.master_id });

    const bad = await call('ui_open', { target: 'resume_editor', resume_id: 'nope' });
    expect(bad.isError).toBe(true);

    events = [];
    await call('ui_open', { target: 'live' });
    expect(events.find(e => e.event === 'career:focus')?.data).toMatchObject({ surface: 'live_drawer' });

    events = [];
    await call('ui_open', { target: 'dossier', application_id: 'app_1' });
    expect(events.find(e => e.event === 'career:focus')?.data).toMatchObject({ surface: 'dossier', application_id: 'app_1' });
  });
});

