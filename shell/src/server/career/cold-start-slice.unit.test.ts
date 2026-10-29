/**
 * 冷启动切面：关键期中途第一次打开、第一次连邮箱。邮箱里近两周的历史邮件一次涌进来，
 * 检验首屏队列只留「现在要你的事」，已经过去的事只进卷宗、不冒充「已过期」。
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLLM } from '@career/core';

import { loadCore } from './core-module';
import { captureIntake } from './intake';
import { setMailCredentialsPath, setMailPassword } from './mail/credentials';
import { syncMailAccount, type FetchedMail } from './mail/sync';
import { CareerStore } from './store';
import { createMemoryRepos } from './test-db';

vi.mock('../sse', () => ({ broadcast: vi.fn() }));

const NOW = '2026-10-29T08:00:00.000Z';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-cold-')); setMailCredentialsPath(join(dir, 'creds.json')); });
afterEach(() => { setMailCredentialsPath(null); rmSync(dir, { recursive: true, force: true }); });

async function deps(llm: FakeLLM) {
  const repos = createMemoryRepos();
  const core = await loadCore();
  return { repos, core, llm, broadcast: () => undefined, sessionId: () => 'global', now: () => NOW };
}

const mail = (uid: number, received_at: string, from: string, subject: string, text: string): FetchedMail =>
  ({ uid, message_id: `<m${uid}@x>`, in_reply_to: null, from, to: 'me@stu.pku.edu.cn', subject, text, received_at });

describe('冷启动 · 关键期中途第一次连邮箱', () => {
  async function firstSync() {
    const llm = new FakeLLM([
      JSON.stringify({ kind: 'other', relevance: 'job', fields: { company: '美团', title: '产品经理' }, summary: '美团已收到简历' }),
      JSON.stringify({ kind: 'written_test', relevance: 'job', fields: { company: '字节跳动', title: '数据分析', due_at: '10月18日 19:00' }, summary: '字节笔试 10 月 18 日' }),
      JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '腾讯', title: '产品策划', round: '一面', when: '10月22日 14:00' }, summary: '腾讯一面 10 月 22 日' }),
      JSON.stringify({ kind: 'rejection', relevance: 'job', fields: { company: '京东' }, summary: '京东感谢信' }),
      JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '阿里巴巴', title: '产品经理', round: '二面', when: '10月31日 10:00' }, summary: '阿里二面 10 月 31 日' }),
    ]);
    const d = await deps(llm);
    const account = d.repos.upsertMailAccount({ provider: 'imap', address: 'me@stu.pku.edu.cn', imap_host: 'mail.pku.edu.cn', smtp_host: 'mail.pku.edu.cn' });
    setMailPassword(account.id, 'code');
    const history = [
      mail(1, '2026-10-16T02:00:00Z', 'noreply@mokahr.com', '美团校招：我们已收到您的简历', '感谢投递产品经理岗位'),
      mail(2, '2026-10-16T03:00:00Z', 'campus@bytedance.com', '字节跳动笔试通知', '请于 10月18日 19:00 参加在线笔试'),
      mail(3, '2026-10-20T03:00:00Z', 'hr@tencent.com', '腾讯面试邀请', '诚邀您参加 10月22日 14:00 一面'),
      mail(4, '2026-10-25T03:00:00Z', 'hr@jd.com', '京东招聘结果', '很遗憾……'),
      mail(5, '2026-10-27T03:00:00Z', 'hr@alibaba.com', '阿里巴巴二面邀请', '诚邀您参加 10月31日 10:00 二面'),
    ];
    const res = await syncMailAccount({ ...d, fetchNew: async () => history }, account);
    return { d, res };
  }

  it('首屏队列不出现历史邮件带来的「已过期」，最急的是后天的二面', async () => {
    const { d, res } = await firstSync();
    expect(res.job_related).toBe(5);
    const today = d.repos.today(NOW);
    expect(today.items.filter(i => i.detail?.includes('已过期'))).toEqual([]);
    const first = today.items.find(i => i.kind === 'deadline' || i.kind === 'interview_today');
    expect(first?.title).toContain('阿里巴巴');
  });

  it('已经过去的笔试、面试照样进卷宗和面试记录，接管的申请都在', async () => {
    const { d } = await firstSync();
    const companies = d.repos.applicationsWithJob().map(a => a.job.company_name).sort();
    expect(companies).toEqual(['字节跳动', '腾讯', '阿里巴巴']);
    const tencent = d.repos.applicationsWithJob().find(a => a.job.company_name === '腾讯')!;
    expect(tencent.stage).toBe('interview');
    expect(d.repos.listDossierNotes(tencent.id).some(n => n.content.includes('10月22日'))).toBe(true);
  });

  it.todo('〔面·等你定 3〕「已收到您的简历」这类投递确认信接管成一份申请（现在只留在收件箱）');
  it.todo('〔面·做法二〕首次连接的历史邮件合成一张接管简报，而不是逐条进通知中心');
});

describe('冷启动 · 用户把一封旧邮件贴进来', () => {
  it('没写年份的日期按收件时间补年份，不会把九月的面试推到明年', async () => {
    const llm = new FakeLLM([JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '网易', title: '运营', round: '一面', when: '9月10日 14:00' }, summary: '网易一面' })]);
    const d = await deps(llm);
    const res = await captureIntake(d, { text: '诚邀您参加 9月10日 14:00 一面', source: 'mail', mail: { subject: '网易面试邀请', received_at: '2026-09-05T02:00:00Z' } });
    const app = d.repos.getApplication(res.created.application_id!)!;
    const itv = new CareerStore(d.repos, d.core).listInterviews().find(i => i.application_id === app.id);
    expect(itv?.date).toBe('2026-09-10T06:00:00.000Z');
    expect(d.repos.listDeadlines({ application_id: app.id }).filter(x => x.due_at?.startsWith('2027'))).toEqual([]);
  });
});
