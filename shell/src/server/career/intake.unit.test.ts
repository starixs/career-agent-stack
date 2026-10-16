import { describe, expect, it, vi } from 'vitest';
import { FakeLLM } from '@career/core';

import { loadCore } from './core-module';
import { captureIntake, captureLink, normalizeIso, recordExam } from './intake';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

const NOW = '2026-10-03T08:00:00.000Z';

async function deps(llm: FakeLLM | null) {
  const repos = createMemoryRepos();
  const core = await loadCore();
  const events: Array<{ event: string; data: unknown }> = [];
  return { repos, core, llm, broadcast: (event: string, data: unknown) => events.push({ event, data }), sessionId: () => 'sess-1', now: () => NOW, events };
}

describe('normalizeIso', () => {
  it('接受 ISO、中文日期与月/日，补年份', () => {
    expect(normalizeIso('2026-10-05T06:00:00Z', NOW)).toBe('2026-10-05T06:00:00.000Z');
    expect(normalizeIso('10月5日 14:00', NOW)).toBe('2026-10-05T06:00:00.000Z');
    expect(normalizeIso('1月3日', NOW)).toBe('2027-01-03T15:59:00.000Z');
    expect(normalizeIso('胡说', NOW)).toBeNull();
  });
});

describe('captureIntake', () => {
  it('没有模型时只落收件箱并指向收件箱面板', async () => {
    const d = await deps(null);
    const res = await captureIntake(d, { text: '随便一段' });
    expect(res.item.status).toBe('new');
    expect(res.focus.surface).toBe('inbox');
    expect(d.events.some(e => e.event === 'career:focus')).toBe(true);
  });

  it('面试邀请：找到同公司投递 → 推进到 interview、建面试记录、面试时间事件、卷宗笔记', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    const job = d.repos.upsertJob({ source_platform: 'boss', source_job_id: '1', title: '数据分析实习生', company_name: '甲公司' });
    const app = d.repos.createApplication(job.id);
    llm.push((req) => {
      expect(req.system).toContain('# 技能：inbox-triage');
      expect(req.messages[0].content).toContain(app.id);
      return JSON.stringify({ kind: 'interview_invite', relevance: 'job', confidence: 0.9, fields: { company: '甲公司', title: '数据分析实习生', round: '一面', when: '2026-10-05T06:00:00Z', location_or_link: 'https://meet.example' }, match: { application_id: app.id }, urgency: 'soon', summary: '甲公司一面，10 月 5 日 14:00' });
    });
    const res = await captureIntake(d, { text: '诚邀您参加 10 月 5 日 14:00 的一面' });
    expect(res.item.status).toBe('processed');
    expect(res.item.kind).toBe('interview_invite');
    expect(d.repos.getApplication(app.id)!.stage).toBe('interview');
    expect(res.created.interview_id).toBeTruthy();
    const deadlines = d.repos.listDeadlines({ application_id: app.id });
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toMatchObject({ kind: 'interview', due_at: '2026-10-05T06:00:00.000Z', url: 'https://meet.example' });
    expect(d.repos.listDossierNotes(app.id)[0].kind).toBe('heard');
    expect(res.focus).toMatchObject({ surface: 'dossier', application_id: app.id });
  });

  it('拒信：关闭投递；Offer：没有投递时自动建岗位与投递并建回复截止', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    const job = d.repos.upsertJob({ source_platform: 'manual', title: '产品', company_name: '乙公司' });
    const app = d.repos.createApplication(job.id);
    llm.push(JSON.stringify({ kind: 'rejection', relevance: 'job', fields: { company: '乙公司' }, summary: '乙公司感谢信' }));
    const rej = await captureIntake(d, { text: '很遗憾……' });
    expect(d.repos.getApplication(app.id)!.stage).toBe('rejected');
    expect(rej.created.closed_application_id).toBe(app.id);

    llm.push(JSON.stringify({ kind: 'offer', relevance: 'job', fields: { company: '丙公司', title: '运营', due_at: '2026-10-10T10:00:00Z' }, summary: '丙公司 offer' }));
    const off = await captureIntake(d, { text: '恭喜你获得录用……' });
    expect(off.created.job_id).toBeTruthy();
    expect(d.repos.getApplication(off.created.application_id!)!.stage).toBe('offer');
    expect(d.repos.listDeadlines({ status: 'open' }).some(x => x.kind === 'offer_reply' && x.offer_id === off.created.offer_id)).toBe(true);
  });

  it('模型判不出来（other）时条目留在 new 让用户处理；模型报错也不丢内容', async () => {
    const llm = new FakeLLM([JSON.stringify({ kind: 'other', relevance: 'job', summary: '看不出来' }), '不是 JSON']);
    const d = await deps(llm);
    const a = await captureIntake(d, { text: '一段看不懂的话' });
    expect(a.item.status).toBe('new');
    expect(a.item.kind).toBe('other');
    const b = await captureIntake(d, { text: '另一段' });
    expect(b.item.status).toBe('new');
    expect(b.item.note).toContain('归类失败');
  });

  it('笔试通知没写时间：仍建一条时间未知的笔试事件，进笔试记录、点亮投递进度，今日队列提示确认时间', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    const job = d.repos.upsertJob({ source_platform: 'manual', title: '研发', company_name: '丁公司' });
    const app = d.repos.createApplication(job.id);
    llm.push(JSON.stringify({ kind: 'written_test', relevance: 'job', fields: { company: '丁公司', title: '研发' }, match: { application_id: app.id }, summary: '丁公司笔试通知，时间另行通知' }));
    const res = await captureIntake(d, { text: '您已进入笔试环节，具体时间另行通知', source: 'mail' });
    expect(res.item.status).toBe('processed');
    expect(res.created.deadline_ids).toHaveLength(1);
    expect(d.repos.getDeadline(res.created.deadline_ids[0])).toMatchObject({ kind: 'written_test', due_at: null, application_id: app.id, status: 'open' });
    expect(d.repos.getApplication(app.id)!.stage).toBe('applied');
    const summary = new CareerStore(d.repos, d.core).dossierSummaries(NOW).find(x => x.application_id === app.id)!;
    expect(summary.exam_kinds).toEqual(['written_test']);
    expect(summary.next_deadline).toBeNull();
    expect(d.repos.today(NOW).items.some(i => i.deadline_id === res.created.deadline_ids[0] && i.due_at === null)).toBe(true);
  });

  it('已在面试的投递又收到测评邮件：阶段不回退、不抛错，测评事件照样落库', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    const job = d.repos.upsertJob({ source_platform: 'manual', title: '产品', company_name: '戊公司' });
    const app = d.repos.createApplication(job.id);
    d.repos.jumpTo(app.id, 'interview', '一面');
    llm.push(JSON.stringify({ kind: 'assessment', relevance: 'job', fields: { company: '戊公司', due_at: '2026-10-06T10:00:00Z' }, match: { application_id: app.id }, summary: '戊公司测评' }));
    const res = await captureIntake(d, { text: '请在 10 月 6 日前完成在线测评' });
    expect(res.item.status).toBe('processed');
    expect(res.item.note).not.toContain('落库失败');
    expect(d.repos.getApplication(app.id)!.stage).toBe('interview');
    expect(d.repos.listDeadlines({ application_id: app.id })).toEqual([expect.objectContaining({ kind: 'assessment', due_at: '2026-10-06T10:00:00.000Z' })]);
  });

  it('JD 入库与邮件建岗写汇总表维度：只记原文字面出现的批次 / 企业性质，拿不到就空', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    llm.push(JSON.stringify({ kind: 'jd', relevance: 'job', fields: { company: '己公司', title: '数据分析' }, summary: '己公司 JD' }));
    llm.push(JSON.stringify({ company: '己公司', title: '数据分析', hard_requirements: [], responsibilities: [], nice_to_have: [], keywords: { covered: [], diggable: [], missing: [] }, notes: ['公司性质：国企'] }));
    const jd = await captureIntake(d, { text: '己公司 2027 届秋招提前批 数据分析岗\n负责经营分析' });
    expect(d.core.parseBoardJson(d.repos.getJob(jd.created.job_id!)!.board_json)).toEqual({ batch: '提前批', industry: null, type_tags: ['国企'] });

    llm.push(JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '庚公司', title: '运营', when: '2026-10-08T06:00:00Z' }, summary: '庚公司面试' }));
    const mail = await captureIntake(d, { text: '邀请您参加春招一面', source: 'mail', mail: { subject: '庚公司春招面试邀请' } });
    expect(d.core.parseBoardJson(d.repos.getJob(mail.created.job_id!)!.board_json)).toEqual({ batch: '春招', industry: null, type_tags: [] });

    llm.push(JSON.stringify({ kind: 'offer', relevance: 'job', fields: { company: '辛公司', title: '研发' }, summary: '辛公司 offer' }));
    const off = await captureIntake(d, { text: '恭喜录用' });
    expect(d.repos.getJob(off.created.job_id!)!.board_json ?? null).toBeNull();
  });
});

describe('captureLink', () => {
  it('抓到分享页：页面文字和粘贴的文案一起交给归档，来源记为 url', async () => {
    const llm = new FakeLLM();
    const d = await deps(llm);
    llm.push((req) => {
      expect(req.messages[0].content).toContain('乙公司 后端开发 笔试通知');
      expect(req.messages[0].content).toContain('我在 Boss 上收到的');
      return JSON.stringify({ kind: 'written_test', relevance: 'job', fields: { company: '乙公司', title: '后端开发', due_at: '2026-10-08T06:00:00Z' }, summary: '乙公司笔试 10 月 8 日' });
    });
    const page = '<html><head><title>乙公司 后端开发 笔试通知</title></head><body><p>请于 10 月 8 日完成</p><script>x()</script></body></html>';
    const fakeFetch = vi.fn(async () => new Response(page, { headers: { 'content-type': 'text/html' } }));
    const res = await captureLink(d, { url: 'https://www.zhipin.com/share/abc', text: '我在 Boss 上收到的' }, fakeFetch as unknown as typeof fetch);
    expect(res.fetched).toBe(true);
    expect(res.item.source).toBe('url');
    expect(d.repos.listDeadlines({}).some(x => x.kind === 'written_test')).toBe(true);
  });

  it('分享页要登录或打不开时不失败，只用链接和粘贴的文案归档', async () => {
    const d = await deps(null);
    const fakeFetch = vi.fn(async () => new Response('', { status: 403 }));
    const res = await captureLink(d, { url: 'https://www.liepin.com/s/xyz' }, fakeFetch as unknown as typeof fetch);
    expect(res.fetched).toBe(false);
    expect(res.item.raw_text).toContain('https://www.liepin.com/s/xyz');
  });

  it('不是链接时直接报错', async () => {
    const d = await deps(null);
    await expect(captureLink(d, { url: '随便写的' })).rejects.toThrow('http');
  });
});

describe('recordExam', () => {
  it('同公司有唯一进行中的投递就挂上去，并建笔试截止事件', async () => {
    const d = await deps(null);
    const job = d.repos.upsertJob({ source_platform: 'boss', source_job_id: '2', title: '算法实习', company_name: '丙公司' });
    const app = d.repos.createApplication(job.id);
    const res = recordExam(d, { company_name: '丙公司', kind: 'written_test', due_at: '2026-10-20T06:00:00.000Z', url: 'https://exam.example' });
    expect(res.application_id).toBe(app.id);
    const dl = d.repos.listDeadlines({ application_id: app.id });
    expect(dl[0]).toMatchObject({ kind: 'written_test', source: 'manual', url: 'https://exam.example', due_at: '2026-10-20T06:00:00.000Z' });
  });

  it('没有投递时新建岗位和投递；测评标题带「测评」', async () => {
    const d = await deps(null);
    const res = recordExam(d, { company_name: '丁公司', title: '产品经理', kind: 'assessment', due_at: '2026-10-21T06:00:00.000Z' });
    const app = d.repos.getApplication(res.application_id)!;
    expect(d.repos.getJob(app.job_id)).toMatchObject({ company_name: '丁公司', title: '产品经理' });
    expect(d.repos.listDeadlines({ application_id: app.id })[0].title).toBe('丁公司 · 产品经理 测评');
  });

  it('公司为空时报错', async () => {
    const d = await deps(null);
    expect(() => recordExam(d, { company_name: '  ', kind: 'written_test', due_at: '2026-10-21T06:00:00.000Z' })).toThrow('公司');
  });
});
