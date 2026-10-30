/**
 * 低谷切面：秋招第六周的周五中午。
 * 从 9 月 14 日起投了 140 家：拒信 31 封、进面试 2 家、其余没有回音；这周一到周五连收 6 封拒信。
 * 另有两条线：美团第一周投的，一直没动静，这周一来了笔试通知（后天考）；字节第一周投的，他 10 月 12 日按静默关掉了，昨天来了面试邀请。
 * - 他问「是不是我不行」：复盘里的数字必须是真的（淡化，不歪曲），基数要来自他自己的历史；
 * - 拒信只计数，不逐条推；
 * - 有笔试的线不能被叫成「静默，建议关闭」；
 * - 关掉的线来了迟到的回信，要接回原来那份申请，不另起一份。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('../career/skills', () => ({ loadSkillPrompt: vi.fn(async (name: string) => `skill:${name}`) }));

import { FakeLLM, StaticKeyProvider, Vault, type Repos } from '@career/core';

import { loadCore } from '../career/core-module';
import { captureIntake } from '../career/intake';
import { lowPointOpener } from '../career/low-point';
import { RunRegistry } from '../career/runs';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

/** 周五 12:00（东八区） */
const NOW = '2026-10-23T04:00:00.000Z';
const WEEK1 = Date.parse('2026-09-14T02:00:00.000Z');
const DAY = 86_400_000;
/** 每周投出的份数，合计 140 */
const SENT_PER_WEEK = [25, 25, 24, 22, 21, 23];
/** 第 1～5 周投出的里面后来收到拒信的份数（拒信落在投出后 6～12 天，第六周之前），合计 25；另外 6 封落在这周一到周五 */
const EARLY_REJECTED_PER_WEEK = [8, 7, 6, 4, 0, 0];

const at = (ms: number) => vi.setSystemTime(new Date(ms));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { isError: !!res.isError, json: () => JSON.parse(res.content[0].text) as Record<string, unknown> };
};

interface Season { meituan: string; bytedance: string; sent: string[] }

function send(repos: Repos, company: string, ms: number): string {
  at(ms);
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${company}`, title: '后端开发', company_name: company });
  const app = repos.createApplication(job.id);
  repos.jumpTo(app.id, 'applied', '已投递');
  return app.id;
}

/** 按时间顺序把这六周放进库里：投出、拒信、两场面试、美团、字节。 */
function buildSeason(repos: Repos): Season {
  const sent: string[] = [];
  const byWeek: string[][] = [];
  SENT_PER_WEEK.forEach((n, w) => {
    const ids = Array.from({ length: n }, (_, i) => send(repos, `公司${w + 1}-${i + 1}`, WEEK1 + w * 7 * DAY + (i % 5) * DAY + i * 60_000));
    byWeek.push(ids); sent.push(...ids);
  });
  // 早先的拒信：投出后一周左右
  EARLY_REJECTED_PER_WEEK.forEach((n, w) => byWeek[w].slice(0, n).forEach((id, i) => { at(WEEK1 + w * 7 * DAY + 6 * DAY + (i % 6) * DAY); repos.jumpTo(id, 'rejected', '收到拒信'); }));
  // 第一周投的两家进了面试（第三、四周）
  at(WEEK1 + 16 * DAY); repos.jumpTo(byWeek[0][20], 'interview', '收到面试邀请（一面）');
  at(WEEK1 + 23 * DAY); repos.jumpTo(byWeek[0][21], 'interview', '收到面试邀请（一面）');
  // 这周一到周五 6 封拒信：落在第四、五周投出的里面
  [...byWeek[3].slice(4, 7), ...byWeek[4].slice(0, 3)].forEach((id, i) => { at(WEEK1 + 35 * DAY + Math.min(i, 4) * DAY + 3_600_000); repos.jumpTo(id, 'rejected', '收到拒信'); });
  // 美团：第一周投的，第六周周一来了笔试通知（后天考），阶段仍是已投递
  const meituan = byWeek[0][22];
  at(WEEK1 + 35 * DAY + 7_200_000);
  repos.createDeadline({ kind: 'written_test', title: '公司1-23 笔试', due_at: '2026-10-25T06:00:00.000Z', application_id: meituan, source: 'mail' });
  repos.addDossierNote({ application_id: meituan, kind: 'heard', content: '笔试：10月25日 14:00' });
  // 字节：第一周投的，10 月 12 日按静默关掉
  const bytedance = byWeek[0][23];
  at(Date.parse('2026-10-12T12:00:00.000Z')); repos.jumpTo(bytedance, 'discarded', '静默超时，主动关闭');
  // 这周还有 10 个只评估过、没投出去的岗位（推荐进待投清单，没批准）
  at(WEEK1 + 35 * DAY + 10_800_000);
  for (let i = 0; i < 10; i++) repos.createApplication(repos.upsertJob({ source_platform: 'campus', source_job_id: `pick-${i}`, title: '后端开发', company_name: `待投${i}` }).id);
  at(Date.parse(NOW));
  return { meituan, bytedance, sent };
}

describe('低谷 · 秋招第六周的周五', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  let season: Season;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    const broadcast = () => undefined;
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 5))), llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async () => undefined,
    });
    season = buildSeason(repos);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('情景本身：140 家投出、31 封拒信、2 家面试，比例照实记在漏斗里', () => {
    const overall = repos.funnel(NOW).overall!;
    expect(overall.applied).toBe(140);
    expect(overall.rejected).toBe(31);
    expect(overall.interview).toBe(2);
  });

  it('拒信只计数：这周 6 封拒信不在今天的队列里逐条出现', () => {
    const titles = repos.today(NOW).items.map(i => i.title).join('\n');
    expect(titles).not.toMatch(/拒/);
  });

  it('「是不是我不行」：不在对话里出周复盘，放一张「我的求职月」卡，本月数字照实', async () => {
    const res = await call('month_review', {});
    expect(res.isError).toBe(false);
    expect(res.json().counts).toEqual(repos.monthBoard({ tzOffsetMinutes: -new Date().getTimezoneOffset() }).counts);
    expect(llm.calls).toHaveLength(0);
  });

  it('有笔试的线不算静默：美团后天考笔试，不会被收起', () => {
    repos.today(NOW);
    expect(repos.getApplication(season.meituan)!.stage).toBe('applied');
  });

  it('没回音的线 AI 自己收起：今日队列只有一条数字，不要他逐条点，也不说「挂了」', () => {
    const stale = repos.today(NOW).items.filter(i => i.kind === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].ref.type).toBe('silent_collected');
    expect(stale[0].title).toMatch(/^这周有 \d+ 家一直没回音，已替你收起$/);
    expect(`${stale[0].title}${stale[0].detail}`).not.toMatch(/挂了|别再想/);
  });

  it('静默阈值：投出 30 天、面试后 21 天才收起', () => {
    repos.today(NOW);
    const stage = (i: number) => repos.getApplication(season.sent[i])!.stage;
    // 第三周 9 月 28 日投出的（25 天）还在等；第一周 9 月 14 日投出的（39 天）收起了
    expect(stage(60)).toBe('applied');
    expect(stage(10)).toBe('discarded');
    // 10 月 7 日面试的（16 天）还在面试中；9 月 30 日面试的（23 天）收起了
    expect(stage(21)).toBe('interview');
    expect(stage(20)).toBe('discarded');
  });

  it('收起的线仍算进漏斗的「静默」，比例照实', () => {
    const before = repos.funnel(NOW).overall!.silent;
    repos.today(NOW);
    expect(repos.funnel(NOW).overall!.silent).toBe(before);
  });

  it('有笔试的线不算进漏斗的「静默」', () => {
    const before = repos.funnel(NOW).overall!.silent;
    repos.db.run('DELETE FROM deadline WHERE application_id=?', [season.meituan]);
    repos.db.run('DELETE FROM dossier_note WHERE application_id=?', [season.meituan]);
    expect(repos.funnel(NOW).overall!.silent).toBe(before + 1);
  });

  it('关掉的线来了迟到的面试邀请：接回原来那份申请，不另起一份', async () => {
    const appsBefore = repos.listApplications().length;
    llm.push(JSON.stringify({ kind: 'interview_invite', relevance: 'job', fields: { company: '公司1-24', round: '一面', when: '10月27日 15:00' }, summary: '公司1-24 一面邀请' }));
    await captureIntake({ repos, core: await loadCore(), llm, broadcast: () => undefined, sessionId: () => 'sess-1', now: () => NOW },
      { text: '诚邀你参加 10月27日 15:00 的一面', source: 'mail' });
    expect(repos.listApplications().length).toBe(appsBefore);
    expect(repos.getApplication(season.bytedance)!.stage).toBe('interview');
  });

  it('关掉的线来了迟到的拒信：记到原来那份申请上，拒信数照实加一', async () => {
    const rejected = repos.funnel(NOW).overall!.rejected;
    llm.push(JSON.stringify({ kind: 'rejection', relevance: 'job', fields: { company: '公司1-24' }, summary: '公司1-24 感谢信' }));
    await captureIntake({ repos, core: await loadCore(), llm, broadcast: () => undefined, sessionId: () => 'sess-1', now: () => NOW },
      { text: '感谢你的关注，很遗憾……', source: 'mail' });
    expect(repos.getApplication(season.bytedance)!.stage).toBe('rejected');
    expect(repos.funnel(NOW).overall!.rejected).toBe(rejected + 1);
  });

  it('连收拒信：不推送；他下一次说话时，助理开头只说一句，带他自己的基数，只说一次', () => {
    const ctx = lowPointOpener(repos, NOW)!;
    expect(ctx).toContain('「这 7 天收到 6 封拒信。你之前投出 60 份才第一次进面试，现在一共 2 个面试。」');
    expect(ctx).toContain('不提换方向');
    expect(lowPointOpener(repos, NOW)).toBeNull();
  });
});
