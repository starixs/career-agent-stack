/**
 * 主链路切面「交简历 → 按岗位定制」（立场 9：和 AI 协作本身不能成为新的劳动）。
 * 新用户拖进一份 PDF 简历 → 一张预填好的卡 → 点一下生成主简历 → 给一个岗位 → 一键定制 → 一眼看出改了什么。
 * 全程用户打字 0 次：简历上已有的不问，缺的在卡里补，JD 读不到走浏览器不让粘贴。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { renderAttachmentContext } from '../career/attachment-reader';
import { RunRegistry } from '../career/runs';
import { CareerStore } from '../career/store';
import { createMemoryRepos } from '../career/test-db';
import { loadCore } from '../career/core-module';
import { handleCareerRoute } from '../routes/career';
import { configureCareerTools, createCareerServer } from './career-tools';

interface CardEvent { card: { id: string; kind: string; data: Record<string, unknown> } }

const RESUME_TEXT = [
  '张小明', '电话：138 1234 5678  邮箱：xiaoming@pku.edu.cn',
  '教育背景', '北京大学 计算机科学与技术 硕士 2024.09 - 2027.06',
  '实习经历', '美团 数据分析实习生 2025.06 - 2025.09',
  '- 搭建日报看板，周会准备时间从 3 小时降到 30 分钟', '- 负责 AB 实验分析，覆盖 12 个策略', '- 参与用户分层模型',
  '项目经历', '校园二手交易小程序 2024.10 - 2025.01', '- 独立开发后端，上线后 2000 名用户',
].join('\n');

const PARSED = {
  profile: { name: '张小明', school: '北京大学', major: '计算机科学与技术', degree: '硕士', graduation: '2027.06' },
  direction: '数据分析',
  education: [{ school: '北京大学', degree: '硕士', major: '计算机科学与技术', start: '2024.09', end: '2027.06' }],
  entries: [
    { section: 'experience', title: '美团 · 数据分析实习生', org: '美团', role: '数据分析实习生', start: '2025.06', end: '2025.09', claims: [
      { text: '搭建日报看板，周会准备时间从 3 小时降到 30 分钟', attribution: 'self', result_metric: '3 小时 → 30 分钟', excerpt: '周会准备时间从 3 小时降到 30 分钟' },
      { text: '负责 AB 实验分析，覆盖 12 个策略', attribution: 'self', result_metric: '12 个策略', excerpt: '覆盖 12 个策略' },
      { text: '参与用户分层模型', attribution: 'team', result_metric: '未知', excerpt: '参与用户分层模型' },
    ] },
    { section: 'project', title: '校园二手交易小程序', org: '', role: '后端开发', start: '2024.10', end: '2025.01', claims: [
      { text: '独立开发后端，上线后 2000 名用户', attribution: 'self', result_metric: '2000 名用户', excerpt: '上线后 2000 名用户' },
    ] },
    { section: 'bogus', title: '' },
  ],
  skills: [{ name: '数据分析', keywords: ['SQL', 'Python'] }],
  awards: [], certifications: [],
};

/** 助理收尾里不该出现的话：让用户打字、粘贴、自己去找。 */
const LABOR_RX = /发给我|告诉我|粘给我|粘贴给我|复制.{0,4}给我|一句话：|改卡片再/;

describe('主链路切面 · 交简历 → 按岗位定制', () => {
  let workspace: string;
  let repos: ReturnType<typeof createMemoryRepos>;
  let vault: Vault;
  let llm: FakeLLM;
  let events: Array<{ event: string; data: CardEvent }>;
  const cards = () => events.filter(e => e.event === 'career:card').map(e => e.data.card);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await mocks.handlers.get(name)!(args);
    return { raw: res.content[0].text, isError: !!res.isError, json: res.isError ? {} : JSON.parse(res.content[0].text) as Record<string, unknown> };
  };
  const confirmRoute = async (intakeId: string, claimIds: string[]) => {
    const res = await handleCareerRoute(`/api/career/resume-intake/${intakeId}/confirm`, new Request('http://x/api/career/resume-intake/confirm', { method: 'POST', body: JSON.stringify({ claim_ids: claimIds }) }),
      { repos, vault, llm: null, broadcast: () => undefined, sessionId: () => 'sess-1', resumeModule: async () => ({ parseResume: (x: unknown) => x }) as never });
    return (await res!.json()) as Record<string, unknown>;
  };

  beforeEach(async () => {
    mocks.handlers.clear();
    workspace = mkdtempSync(join(tmpdir(), 'career-chain-'));
    writeFileSync(join(workspace, '张小明-简历.pdf'), '%PDF-1.4');
    configureCareerTools({}, { sessionId: 'sess-1', workspace });
    repos = createMemoryRepos();
    vault = new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7)));
    llm = new FakeLLM();
    events = [];
    const broadcast = (event: string, data: unknown) => { events.push({ event, data: data as CardEvent }); };
    await createCareerServer({
      repos, vault, llm, broadcast, sessionId: () => 'sess-1', runs: new RunRegistry(broadcast, () => 'sess-1'),
      resumeModule: async () => ({ parseResume: (x: unknown) => x as never }), browserRun: async () => undefined,
      readDocument: async () => ({ ok: true, text: RESUME_TEXT, attempts: [] }),
    });
  });
  afterEach(() => { configureCareerTools({}, { sessionId: 'default' }); rmSync(workspace, { recursive: true, force: true }); });

  it('附件读取认得出简历，直接指向 resume_import，不让助理复述或追问', () => {
    const ctx = renderAttachmentContext([{ name: '张小明-简历.pdf', path: '张小明-简历.pdf', ok: true, text: RESUME_TEXT, attempts: [] } as never])!;
    expect(ctx).toContain('resume_import(path="张小明-简历.pdf")');
    const other = renderAttachmentContext([{ name: '会议纪要.pdf', path: '会议纪要.pdf', ok: true, text: '本周进度同步', attempts: [] } as never])!;
    expect(other).not.toContain('resume_import');
  });

  it('拖进简历：基本信息补进私密库、经历按段落进库，只出一张预填好的卡，明文不进对话', async () => {
    vault.set({ scope: 'profile', field: 'email', value: 'mine@qq.com' });
    llm.push(JSON.stringify(PARSED));
    const res = await call('resume_import', { path: '张小明-简历.pdf' });
    expect(res.isError).toBe(false);

    // 用户填过的邮箱不被简历覆盖；其余核心项从简历补齐，卡片里不用再填
    const filled = Object.fromEntries(vault.status().profile.filled.map(f => [f.field, f.preview]));
    expect(Object.keys(filled).sort()).toEqual(['degree', 'email', 'graduation', 'major', 'name', 'phone', 'school']);
    expect(vault.reveal(vault.list().find(i => i.field === 'email')!.id, { actor: 'test', purpose: 'test' })).toBe('mine@qq.com');
    expect(vault.reveal(vault.list().find(i => i.field === 'graduation')!.id, { actor: 'test', purpose: 'test' })).toBe('2027-06');

    // 两段经历各一条，不再是一条以文件名命名的经历；说法待确认
    expect(repos.listExperiences().map(e => e.title).sort()).toEqual(['校园二手交易小程序', '美团 · 数据分析实习生']);
    expect(repos.listClaims().every(c => c.status === 'pending')).toBe(true);

    const intake = cards().filter(c => c.kind === 'resume_intake');
    expect(intake).toHaveLength(1);
    expect(cards().filter(c => c.kind === 'vault_missing' || c.kind === 'claims_confirm')).toEqual([]);
    expect(intake[0].data.missing).toEqual([]);
    expect((intake[0].data.experiences as Array<{ claims: unknown[] }>).map(e => e.claims.length)).toEqual([3, 1]);
    const cardJson = JSON.stringify(intake[0].data);
    expect(cardJson).not.toContain('13812345678');
    expect(JSON.stringify(intake[0].data.profile)).not.toContain('张小明');

    // 工具结果：没有明文、没有让用户发东西
    expect(res.raw).not.toContain('13812345678');
    expect(res.raw).not.toContain('xiaoming@pku.edu.cn');
    expect(res.json.note).not.toMatch(LABOR_RX);
  });

  it('简历上没写的核心项，就在同一张卡里带输入框（不另出一张，也不在对话里问）', async () => {
    llm.push(JSON.stringify({ ...PARSED, profile: { name: '张小明' }, education: [] }));
    await call('resume_import', { path: '张小明-简历.pdf' });
    const intake = cards().find(c => c.kind === 'resume_intake')!;
    expect((intake.data.missing as Array<{ field: string }>).map(m => m.field)).toEqual(['school', 'major', 'degree', 'graduation']);
    expect(cards().filter(c => c.kind === 'vault_missing')).toEqual([]);
  });

  it('卡里点一下：勾上的说法确认、直接组装主简历（不调模型），没勾的不进简历', async () => {
    llm.push(JSON.stringify(PARSED));
    const imported = await call('resume_import', { path: '张小明-简历.pdf' });
    const claims = repos.listClaims();
    const dropped = claims.find(c => c.text === '参与用户分层模型')!;
    const callsBefore = llm.calls.length;
    const out = await confirmRoute(imported.json.intake_id as string, claims.filter(c => c.id !== dropped.id).map(c => c.id));
    expect(llm.calls.length).toBe(callsBefore);

    const master = new CareerStore(repos, await loadCore()).getResume(out.master_id as string)!;
    const schema = JSON.parse(master.row.schema_json) as { basics: Record<string, string>; education: Array<Record<string, string>>; experience: Array<{ org: string; bullets: string[] }>; projects: Array<{ name: string }> };
    expect(schema.basics.name).toBe('{{vault:profile.name}}');
    expect(schema.education[0]).toMatchObject({ school: '北京大学', degree: '硕士', start: '2024.09', end: '2027.06' });
    expect(schema.experience[0].org).toBe('美团');
    expect(schema.experience[0].bullets).toEqual(['搭建日报看板，周会准备时间从 3 小时降到 30 分钟', '负责 AB 实验分析，覆盖 12 个策略']);
    expect(schema.projects.map(p => p.name)).toEqual(['校园二手交易小程序']);
    expect(repos.listClaims().find(c => c.id === dropped.id)!.status).toBe('pending');

    // 再点一次只更新同一份主简历，不会冒出第二份让定制时还要选
    const again = await confirmRoute(imported.json.intake_id as string, claims.map(c => c.id));
    expect(again.master_id).toBe(out.master_id);
    expect(new CareerStore(repos, await loadCore()).listResumeMasters()).toHaveLength(1);
  });

  it('已有一份有内容的主简历，又拖进简历：替换那一份（留快照），始终只有一份主简历', async () => {
    const store = new CareerStore(repos, await loadCore());
    const old = store.createResumeMaster({ name: '访谈版', schema_json: { version: 1, experience: [{ org: '旧公司', bullets: ['旧的一条'] }] } });
    llm.push(JSON.stringify(PARSED));
    const imported = await call('resume_import', { path: '张小明-简历.pdf' });
    const out = await confirmRoute(imported.json.intake_id as string, repos.listClaims().map(c => c.id));
    expect(out.master_id).toBe(old.id);
    expect(store.listResumeMasters()).toHaveLength(1);
    expect(JSON.parse(store.getResume(old.id)!.row.schema_json).experience[0].org).toBe('美团');
    const snaps = repos.db.all<{ schema_json: string }>('SELECT schema_json FROM resume_snapshot WHERE resume_id=?', [old.id]);
    expect(snaps.some(s => s.schema_json.includes('旧公司'))).toBe(true);
  });

  it('给岗位一键定制：JD 没解析就自动解析；模型写错的顶层键也落到简历上；出「改了什么」卡', async () => {
    llm.push(JSON.stringify(PARSED));
    const imported = await call('resume_import', { path: '张小明-简历.pdf' });
    await confirmRoute(imported.json.intake_id as string, repos.listClaims().map(c => c.id));
    const job = repos.upsertJob({ source_platform: 'manual', title: '数据分析师', company_name: '京东', url: null, jd_raw: '负责经营分析，要求熟练 SQL、AB 实验经验' });

    llm.push(JSON.stringify({ title: '数据分析师', company: '京东', location: ['北京'] }));
    llm.push(JSON.stringify({
      strength: 'keywords',
      patch: [{ op: 'replace', path: '/experiences/0/bullets/1', value: '主导 12 个策略的 AB 实验分析，产出上线结论' }, { op: 'replace', path: '/nonsense/0', value: 'x' }],
      reasons: [{ path: '/experiences/0/bullets/1', reason: 'JD 强调 AB 实验', claim_ids: [] }],
      unresolved: [{ need: 'JD 要 Tableau，经历里没提到', why: '' }],
    }));
    const res = await call('resume_tailor', { job_id: job.id });
    expect(res.isError).toBe(false);
    expect(repos.getJob(job.id)!.jd_parsed_json).toBeTruthy();

    const store = new CareerStore(repos, await loadCore());
    const tailored = store.getResume(res.json.tailored_id as string)!;
    const schema = JSON.parse(tailored.row.schema_json) as Record<string, unknown> & { experience: Array<{ bullets: string[] }> };
    expect(schema.experience[0].bullets[1]).toBe('主导 12 个策略的 AB 实验分析，产出上线结论');
    expect(schema.experiences).toBeUndefined();
    expect(schema.nonsense).toBeUndefined();

    const diff = cards().find(c => c.kind === 'tailor_diff')!;
    expect(diff.data).toMatchObject({ tailored_id: tailored.row.id, total: 1, needs: ['JD 要 Tableau，经历里没提到'] });
    expect((diff.data.changes as unknown[])[0]).toEqual({ op: 'replace', place: '实习 / 工作 · 美团 · 第 2 条', before: '负责 AB 实验分析，覆盖 12 个策略', after: '主导 12 个策略的 AB 实验分析，产出上线结论', reason: 'JD 强调 AB 实验', jd: [] });
    expect(res.json.note).not.toMatch(LABOR_RX);
  });

  it('简历和资料对不上：同一张卡里并排列出、默认以简历为准，点一下全部同步；不在对话里对账', async () => {
    vault.set({ scope: 'profile', field: 'name', value: '林小舟' });
    vault.set({ scope: 'profile', field: 'school', value: '华东某大学' });
    vault.set({ scope: 'profile', field: 'major', value: '计算机科学与技术' });
    llm.push(JSON.stringify(PARSED));
    const res = await call('resume_import', { path: '张小明-简历.pdf' });
    const reveal = (field: string) => vault.reveal(vault.list().find(i => i.field === field)!.id, { actor: 'test', purpose: 'test' });
    expect(reveal('name')).toBe('林小舟');

    const intake = cards().find(c => c.kind === 'resume_intake')!;
    expect(intake.data.conflicts).toEqual([
      { field: 'name', label: '真实姓名', resume_preview: '张**', vault_preview: '林**' },
      { field: 'school', label: '毕业院校', resume_preview: '北京大学', vault_preview: '华东某大学' },
    ]);
    expect(String(res.json.note)).toContain('默认以这份简历为准');
    expect(res.raw).not.toContain('张小明');

    await confirmRoute(res.json.intake_id as string, repos.listClaims().map(c => c.id));
    expect(reveal('name')).toBe('张小明');
    expect(reveal('school')).toBe('北京大学');
    expect(repos.kvGet<Record<string, unknown>>(`resume_intake:${res.json.intake_id as string}`)!.pending_profile).toBeUndefined();
  });

  it('冲突里选「保留资料里的」：资料不动，主简历的教育用资料占位', async () => {
    vault.set({ scope: 'profile', field: 'school', value: '华东某大学' });
    llm.push(JSON.stringify(PARSED));
    const res = await call('resume_import', { path: '张小明-简历.pdf' });
    const res2 = await handleCareerRoute(`/api/career/resume-intake/${res.json.intake_id as string}/confirm`, new Request('http://x', { method: 'POST', body: JSON.stringify({ claim_ids: [], profile_choice: { school: 'vault' } }) }),
      { repos, vault, llm: null, broadcast: () => undefined, sessionId: () => 'sess-1', resumeModule: async () => ({ parseResume: (x: unknown) => x }) as never });
    const out = await res2!.json() as { master_id: string };
    expect(vault.reveal(vault.list().find(i => i.field === 'school')!.id, { actor: 'test', purpose: 'test' })).toBe('华东某大学');
    const master = new CareerStore(repos, await loadCore()).getResume(out.master_id)!;
    expect(JSON.parse(master.row.schema_json).education[0].school).toBe('{{vault:profile.school}}');
  });

  it('定制的防编造闸门在工具里：改事实、串位、加料的改动拦下，不进简历，列在卡上', async () => {
    llm.push(JSON.stringify(PARSED));
    const imported = await call('resume_import', { path: '张小明-简历.pdf' });
    await confirmRoute(imported.json.intake_id as string, repos.listClaims().map(c => c.id));
    const projectClaim = repos.listClaims().find(c => c.text.startsWith('独立开发后端'))!;
    const job = repos.upsertJob({ source_platform: 'manual', title: '后端', company_name: '京东', jd_raw: '后端开发，熟悉 Kafka', jd_parsed_json: JSON.stringify({ title: '后端' }) });
    llm.push(JSON.stringify({
      patch: [
        { op: 'replace', path: '/experience/0/org', value: '阿里巴巴' },
        { op: 'add', path: '/experience/0/bullets/-', value: '独立开发后端，上线后 2000 名用户' },
        { op: 'replace', path: '/experience/0/bullets/0', value: '用 Kafka 搭建日报看板，周会准备时间从 3 小时降到 30 分钟' },
        { op: 'replace', path: '/experience/0/bullets/1', value: '负责 12 个策略的 AB 实验分析' },
      ],
      reasons: [
        { path: '/experience/0/bullets/-', reason: '补充交付', claim_ids: [projectClaim.id] },
        { path: '/experience/0/bullets/1', reason: '对齐数据驱动', jd_keywords: ['AB 实验'] },
      ],
      unresolved: [],
    }));
    const res = await call('resume_tailor', { job_id: job.id });
    const tailored = new CareerStore(repos, await loadCore()).getResume(res.json.tailored_id as string)!;
    const exp = JSON.parse(tailored.row.schema_json).experience[0] as { org: string; bullets: string[] };
    expect(exp.org).toBe('美团');
    expect(exp.bullets).toEqual(['搭建日报看板，周会准备时间从 3 小时降到 30 分钟', '负责 12 个策略的 AB 实验分析', '参与用户分层模型']);
    const diff = cards().find(c => c.kind === 'tailor_diff')!;
    expect(diff.data.total).toBe(1);
    expect((diff.data.changes as Array<{ jd: string[] }>)[0].jd).toEqual(['AB 实验']);
    expect((diff.data.blocked as Array<{ why: string }>).map(b => b.why)).toEqual([
      '改了事实字段（机构 / 职位 / 时间 / 学校这类不改）',
      '用了另一段经历的主张（串位）',
      '出现了没有依据的内容：Kafka',
    ]);
    expect(res.json.blocked).toBe(3);
  });

  it('岗位只有链接、读不到正文：指向浏览器和请用户登录，不让用户复制粘贴，也不空调模型', async () => {
    await mocks.handlers.get('resume_master_create')!({ draft: false });
    const job = repos.upsertJob({ source_platform: 'manual', title: '产品经理', company_name: '小红书', url: 'https://job.xiaohongshu.com/123' });
    const calls = llm.calls.length;
    const res = await call('resume_tailor', { job_id: job.id });
    expect(res.isError).toBe(true);
    expect(res.raw).toContain('browser_open');
    expect(res.raw).toContain('browser_wait_user');
    expect(res.raw).toContain('不要让用户复制粘贴');
    expect(llm.calls.length).toBe(calls);
  });

  it('没拖简历也建主简历：教育背景从私密库取，缺的核心项出补齐卡，不让助理逐区复述确认', async () => {
    vault.set({ scope: 'profile', field: 'school', value: '复旦大学' });
    vault.set({ scope: 'profile', field: 'major', value: '新闻学' });
    const res = await call('resume_master_create', { draft: false });
    const master = new CareerStore(repos, await loadCore()).getResume(res.json.master_id as string)!;
    expect(JSON.parse(master.row.schema_json).education[0]).toMatchObject({ school: '{{vault:profile.school}}', major: '{{vault:profile.major}}' });
    const missing = cards().find(c => c.kind === 'vault_missing')!;
    expect((missing.data.fields as Array<{ field: string }>).map(f => f.field)).toEqual(['name', 'phone', 'email', 'degree', 'graduation']);
    expect(String(res.json.note)).not.toMatch(LABOR_RX);
    expect(String(res.json.note)).not.toContain('复述给用户确认');
  });
});
