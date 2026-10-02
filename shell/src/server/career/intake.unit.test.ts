import { describe, expect, it, vi } from 'vitest';
import { FakeLLM } from '@career/core';

import { loadCore } from './core-module';
import { captureIntake, normalizeIso } from './intake';
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
});
