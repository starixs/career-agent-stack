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
    for (const name of ['resume_list', 'resume_master_create', 'resume_get', 'resume_save', 'resume_tailor', 'resume_export']) {
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
    for (const name of ['today_queue', 'inbox_capture', 'inbox_list', 'inbox_dismiss', 'account_fetch_report', 'deadline_add', 'deadline_done', 'dossier_list', 'dossier_get', 'dossier_note_add', 'application_set_stage', 'material_list', 'material_draft', 'material_save', 'material_use_record', 'month_review', 'mail_accounts', 'mail_sync', 'mail_list', 'mail_compose']) {
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

  it('material_save 落库并推 focus；mail_compose 不在这一轮起草：建投递、排后台写邮件，结果只给收件域名', async () => {
    const saved = (await call('material_save', { kind: 'why_company', title: '为什么选甲', content: '因为……' })).json();
    expect((saved.material as { confirmed: number }).confirmed).toBe(1);
    expect(events.some(e => e.event === 'career:focus' && (e.data as { surface: string }).surface === 'material')).toBe(true);

    // 收件人不像邮箱：直接说，不开始
    const bad = await call('mail_compose', { to: 'hr', job_id: 'job_x' });
    expect(bad.isError).toBe(true);
    // 岗位没写投递邮箱、也没给收件人：问他发到哪
    await call('resume_master_create', { name: '通用版', basics: {} });
    const webJob = repos.upsertJob({ source_platform: 'manual', title: '后端', company_name: '乙公司', url: 'https://b.com/apply' });
    const noTo = await call('mail_compose', { job_id: webJob.id });
    expect(noTo.isError).toBe(true);
    expect(noTo.content[0].text).toContain('投递邮箱');

    // 没连邮箱也照样开始（过目时再请他连）；不调模型、不发信
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析', company_name: '甲公司', jd_raw: 'JD' });
    const out = (await call('mail_compose', { to: 'hr@a.com', job_id: job.id, notes: '语气正式一点' })).json();
    expect(out).toMatchObject({ company: '甲公司', title: '数据分析', to_domain: 'a.com', started: true });
    expect(JSON.stringify(out)).not.toContain('hr@a.com');
    const action = repos.getAction(out.action_id as string)!;
    expect(action.kind).toBe('draft_mail');
    expect(action.status).toBe('approved');
    expect(JSON.parse(action.payload_json)).toMatchObject({ to: 'hr@a.com', notes: '语气正式一点', job_id: job.id });
    expect(repos.getJob(job.id)!.apply_email).toBe('hr@a.com');
    expect(llm.calls).toHaveLength(0);
    expect(repos.listActions().some(a => a.kind === 'send_mail')).toBe(false);
    expect(repos.listMailMessages({ direction: 'out' })).toHaveLength(0);

    // 只说了公司和岗位名：建一条手动岗位再走同一条路
    const manual = (await call('mail_compose', { to: 'campus@c.cn', company: '丙公司', title: '产品实习生' })).json();
    expect(manual).toMatchObject({ company: '丙公司', title: '产品实习生', started: true, to_domain: 'c.cn' });
    expect(repos.listJobs().find(j => j.company_name === '丙公司')).toMatchObject({ source_platform: 'manual', apply_email: 'campus@c.cn' });
  });

  it('mail_reply：找这份最近一封来信，排一封回信草稿（后台写，不发、不调模型），结果只给收件域名', async () => {
    const job = repos.upsertJob({ source_platform: 'manual', title: '产品实习生', company_name: '甲公司', apply_email: 'hr@jia.com' });
    const app = repos.createApplication(job.id);
    const none = await call('mail_reply', { application_id: app.id });
    expect(none.isError).toBe(true);
    const account = repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    const mail = repos.insertMailMessage({ account_id: account.id, uid: 1, message_id: '<in1@jia.com>', in_reply_to: null, direction: 'in', from_addr: 'HR <hr@jia.com>', to_addr: 'me@qq.com', subject: '到岗时间', snippet: '', body_text: '你最早什么时候能到岗？', received_at: new Date().toISOString(), relevance: 'job', kind: 'other', inbox_item_id: null, application_id: app.id, action_id: null })!;
    const out = (await call('mail_reply', { application_id: app.id, notes: '下周一能到岗' })).json();
    expect(out).toMatchObject({ company: '甲公司', title: '产品实习生', to_domain: 'jia.com', started: true });
    expect(JSON.stringify(out)).not.toContain('hr@jia.com');
    const action = repos.getAction(out.action_id as string)!;
    expect(action).toMatchObject({ kind: 'draft_mail', status: 'approved', application_id: app.id });
    expect(JSON.parse(action.payload_json)).toMatchObject({ purpose: 'reply', reply_to_mail_id: mail.id, notes: '下周一能到岗' });
    expect(llm.calls).toHaveLength(0);
    expect(repos.listActions().some(a => a.kind === 'send_mail')).toBe(false);
  });
});

describe('skillProgressMessage', () => {
  it('describes the work instead of exposing the skill id', () => {
    expect(skillProgressMessage('resume-tailor')).toBe('正在改简历');
    expect(skillProgressMessage('probe-predict')).toBe('正在预测面试追问');
    expect(skillProgressMessage('some-new-skill')).toBe('正在想');
  });
});
