/**
 * 冷启动切面：关键期中途第一次打开、第一次连邮箱。几个月的历史邮件一次收进来：
 * 规则认得出的直接接管成申请，只有近两周可能还没发生的事才调模型；
 * 首屏队列只留「现在要你的事」，已经过去的事只进卷宗、不冒充「已过期」。
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
  const history = [
    mail(1, '2026-08-20T02:00:00Z', '美团校园招聘 <noreply@mokahr.com>', '【美团】已收到您的简历', '感谢投递产品经理岗位'),
    mail(2, '2026-09-05T03:00:00Z', 'campus@bytedance.com', '字节跳动2026校园招聘笔试通知', '请于 9月10日 19:00 参加在线笔试'),
    mail(3, '2026-09-12T03:00:00Z', 'hr@tencent.com', '【腾讯】面试邀请', '诚邀您参加 9月15日 14:00 一面'),
    mail(4, '2026-09-20T03:00:00Z', 'hr@jd.com', '京东集团校园招聘：很遗憾', '感谢您的关注……'),
    mail(5, '2026-09-25T03:00:00Z', 'noreply@mokahr.com', '您有一条新的通知', '请登录查看'),
    mail(6, '2026-10-10T03:00:00Z', 'news@shop.com', '双十一优惠', '买买买'),
    mail(7, '2026-10-27T03:00:00Z', 'hr@alibaba.com', '阿里巴巴二面邀请', '诚邀您参加 10月31日 10:00 二面'),
    mail(8, '2026-10-28T03:00:00Z', '网易招聘 <hr@163.com>', '【网易】感谢您的投递', '我们已收到您的申请'),
  ];

  async function firstSync() {
    // 只有阿里这封（近两周、可能还没发生）会调模型
    const llm = new FakeLLM([
      JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '阿里巴巴', title: '产品经理', round: '二面', when: '10月31日 10:00' }, summary: '阿里二面 10 月 31 日' }),
    ]);
    const d = await deps(llm);
    const account = d.repos.upsertMailAccount({ provider: 'qq', address: 'me@qq.com', imap_host: 'imap.qq.com', smtp_host: 'smtp.qq.com' });
    setMailPassword(account.id, 'code');
    const res = await syncMailAccount({ ...d, fetchNew: async () => history }, account);
    return { d, res, llm, account };
  }

  it('几个月的求职邮件都接管成申请，阶段按邮件推到位；只调一次模型', async () => {
    const { d, res, llm } = await firstSync();
    const stages = Object.fromEntries(d.repos.applicationsWithJob().map(a => [a.job.company_name, a.stage]));
    expect(stages).toEqual({ 美团: 'applied', 字节跳动: 'applied', 腾讯: 'interview', 京东: 'rejected', 阿里巴巴: 'interview', 网易: 'applied' });
    expect(llm.calls).toHaveLength(1);
    expect(res.history).toEqual({ by_rules: 5, by_model: 1, unclassified: 1 });
  });

  it('无关邮件不进库；认不出的求职邮件留着，不乱建申请', async () => {
    const { d, account } = await firstSync();
    const subjects = d.repos.listMailMessages({ account_id: account.id }).map(m => m.subject);
    expect(subjects).not.toContain('双十一优惠');
    expect(subjects).toContain('您有一条新的通知');
  });

  it('首屏队列不出现「已过期」，最急的是后天的二面；通知中心只有那一件', async () => {
    const { d } = await firstSync();
    const today = d.repos.today(NOW);
    expect(today.items.filter(i => i.detail?.includes('已过期'))).toEqual([]);
    expect(today.items.find(i => i.kind === 'deadline' || i.kind === 'interview_today')?.title).toContain('阿里巴巴');
    const visible = [...d.repos.listInbox('new'), ...d.repos.listInbox('processed')];
    expect(visible.map(i => i.kind)).toEqual(['interview_invite']);
  });

  it('阶段流转记在邮件到达的月份，「我的求职月」不会把八月的投递算到十月', async () => {
    const { d } = await firstSync();
    const meituan = d.repos.applicationsWithJob().find(a => a.job.company_name === '美团')!;
    const applied = d.repos.db.all<{ to_stage: string; created_at: string }>('SELECT to_stage, created_at FROM application_history WHERE application_id=?', [meituan.id]).find(h => h.to_stage === 'applied');
    expect(applied?.created_at.slice(0, 7)).toBe('2026-08');
  });

  it('过去的面试只进卷宗，带上从正文抠出的时间', async () => {
    const { d } = await firstSync();
    const tencent = d.repos.applicationsWithJob().find(a => a.job.company_name === '腾讯')!;
    const itv = new CareerStore(d.repos, d.core).listInterviews().find(i => i.application_id === tencent.id);
    expect(itv?.date).toBe('2026-09-15T06:00:00.000Z');
    expect(d.repos.listDeadlines({ application_id: tencent.id })).toEqual([]);
  });

  it.todo('〔面·做法二〕首次连接的历史邮件合成一张接管简报');
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
