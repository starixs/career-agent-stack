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
import { createCareerServer, skillProgressMessage } from './career-tools';

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

describe('career 五个面的工具', () => {
  let llm: FakeLLM;
  let events: Array<{ event: string; data: unknown }>;
  let repos: ReturnType<typeof createMemoryRepos>;

  beforeEach(async () => {
    mocks.handlers.clear();
    llm = new FakeLLM();
    events = [];
    repos = createMemoryRepos();
    await createCareerServer({ repos, llm, broadcast: (event, data) => events.push({ event, data }), sessionId: () => 'sess-1', resumeModule: async () => ({ parseResume }) });
  });

  it('注册了全部新工具', () => {
    for (const name of ['today_queue', 'inbox_capture', 'inbox_list', 'inbox_dismiss', 'account_fetch_report', 'deadline_add', 'deadline_done', 'dossier_list', 'dossier_get', 'dossier_note_add', 'application_set_stage', 'material_list', 'material_draft', 'material_save', 'material_use_record', 'weekly_review', 'mail_accounts', 'mail_sync', 'mail_list', 'mail_compose']) {
      expect(mocks.handlers.has(name), name).toBe(true);
    }
  });

  it('inbox_capture 走 inbox-triage 技能并推 focus；today_queue 能看到新建的截止事件', async () => {
    const job = repos.upsertJob({ source_platform: 'manual', title: '运营实习生', company_name: '甲公司' });
    const app = repos.createApplication(job.id);
    llm.push(JSON.stringify({ kind: 'written_test', relevance: 'job', fields: { company: '甲公司', due_at: new Date(Date.now() + 3600_000).toISOString() }, match: { application_id: app.id }, summary: '甲公司笔试，一小时后' }));
    const out = (await call('inbox_capture', { text: '笔试通知……' })).json();
    expect(out.kind).toBe('written_test');
    expect(out.status).toBe('processed');
    expect((out.created as { deadline_ids: string[] }).deadline_ids).toHaveLength(1);
    expect(events.some(e => e.event === 'career:focus' && (e.data as { surface: string }).surface === 'dossier')).toBe(true);
    const today = (await call('today_queue')).json();
    expect((today.items as Array<{ kind: string; title: string }>).some(i => i.kind === 'deadline' && i.title.includes('笔试'))).toBe(true);
  });

  it('dossier_get 按公司名找到唯一投递；application_set_stage 沿合法路径推进；dossier_note_add 记"我说过"', async () => {
    const job = repos.upsertJob({ source_platform: 'manual', title: '产品', company_name: '乙公司' });
    const app = repos.createApplication(job.id);
    const moved = (await call('application_set_stage', { application_id: app.id, stage: 'interview', note: '进面了' })).json();
    expect((moved.application as { stage: string }).stage).toBe('interview');
    await call('dossier_note_add', { application_id: app.id, kind: 'said', round: 'first', content: '可以 7 月到岗' });
    const dossier = (await call('dossier_get', { company_name: '乙公司' })).json();
    expect((dossier.notes as Array<{ content: string }>)[0].content).toContain('7 月');
    expect((dossier.history as unknown[]).length).toBeGreaterThan(1);
    const missing = await call('dossier_get', { company_name: '不存在' });
    expect(missing.isError).toBe(true);
  });

  it('material_save 落库并推 focus；mail_compose 只入待审队列，不发送', async () => {
    const saved = (await call('material_save', { kind: 'why_company', title: '为什么选甲', content: '因为……' })).json();
    expect((saved.material as { confirmed: number }).confirmed).toBe(1);
    expect(events.some(e => e.event === 'career:focus' && (e.data as { surface: string }).surface === 'material')).toBe(true);

    const noAccount = await call('mail_compose', { to: 'hr@a.com', job_id: 'job_x' });
    expect(noAccount.isError).toBe(true);
    expect(noAccount.content[0].text).toContain('绑定邮箱');

    repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '甲公司', jd_raw: 'JD' });
    llm.push(JSON.stringify({ email: { subject: '应聘【数据分析】-某校-张三', body: '您好……', signature: '张三' }, attachment_name: '', short_message: '' }));
    const out = (await call('mail_compose', { to: 'hr@a.com', job_id: job.id })).json();
    expect(out.subject).toContain('应聘');
    const action = repos.getAction(out.action_id as string)!;
    expect(action.kind).toBe('send_mail');
    expect(action.status).toBe('pending_review');
    expect(JSON.parse(action.payload_json).to).toBe('hr@a.com');
    expect(repos.listMailMessages({ direction: 'out' })).toHaveLength(0);
    expect(events.some(e => e.event === 'career:review')).toBe(true);
  });
});

describe('skillProgressMessage', () => {
  it('describes the work instead of exposing the skill id', () => {
    expect(skillProgressMessage('resume-tailor')).toBe('正在改简历');
    expect(skillProgressMessage('probe-predict')).toBe('正在预测面试追问');
    expect(skillProgressMessage('some-new-skill')).toBe('正在想');
  });
});
