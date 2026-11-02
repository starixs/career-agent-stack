/**
 * 准备期切面：几周来一次，一段经历分几次才补得完。
 * 十月初聊了一半美团实习、顺手开了课程项目的头；三周后回来，接着补美团那段，再练一遍项目讲述。
 * 单位是「一段经历」：补到一半的经历各自记着还要问什么，接着补时落在原经历上，讲述里冒出的新事实也要能确认。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: { tools: unknown[] }) => ({ type: 'sdk', name: 'career', config })),
  tool: vi.fn((name: string, _description: string, _schema: unknown, handler: Handler) => { mocks.handlers.set(name, handler); return { name }; }),
}));
vi.mock('../browser-host/capability-client', () => ({ acquireBrowserCapability: vi.fn() }));
vi.mock('../sse', () => ({ broadcast: vi.fn() }));
vi.mock('../career/domain', async (orig) => ({
  ...(await orig<typeof import('../career/domain')>()),
  loadBridges: async () => ({
    mineRepo: async () => ({ claims: [], notes: [], dropped: [] }),
    importMineResult: (r: { addClaim: (c: { experience_id: string; text: string; created_from: string }) => unknown }, experienceId: string) =>
      ({ claims: [r.addClaim({ experience_id: experienceId, text: '独立实现看板的增量刷新', created_from: 'repo' })], evidence: [] }),
  }),
}));

import { FakeLLM, StaticKeyProvider, Vault } from '@career/core';

import { RunRegistry } from '../career/runs';
import { createMemoryRepos } from '../career/test-db';
import { createCareerServer } from './career-tools';

/** 这几个工具返回里测试用到的字段。 */
interface ToolJson { experience: { id: string }; open_experiences?: Array<{ id: string; follow_up_questions: string[] }> }
interface CardEvent { card: { kind: string; data: Record<string, unknown> } }

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return JSON.parse(res.content[0].text) as ToolJson;
};

describe('准备期 · 三周后回来接着补经历', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  let llm: FakeLLM;
  let events: Array<{ event: string; data: CardEvent }>;
  const cards = () => events.filter(e => e.event === 'career:card').map(e => e.data.card);

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    llm = new FakeLLM();
    events = [];
    const broadcast = (event: string, data: unknown) => { events.push({ event, data: data as CardEvent }); };
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 3))), llm, broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
      browserRun: async () => undefined,
    });
  });

  /** 十月初那次：美团聊了一半，课程项目开了个头，都没聊完就走了。 */
  async function firstVisit() {
    const mt = await call('experience_add', { title: '数据分析实习', org: '美团', role: '数据分析实习生', start_date: '2026-06', claims: [{ text: '搭建外卖履约看板', attribution: 'self' }] });
    await call('experience_interview', { round: 'internship', status: 'in_progress', experience_id: mt.experience.id, follow_up_questions: ['看板每天多少人在用？', '你一个人做的还是和组里一起？'] });
    const course = await call('experience_add', { title: '推荐系统课程大作业', claims: [{ text: '实现协同过滤召回', attribution: 'team' }] });
    await call('experience_interview', { round: 'course_project', status: 'in_progress', experience_id: course.experience.id, follow_up_questions: ['召回率提升了多少？'] });
    return { mtId: mt.experience.id as string, courseId: course.experience.id as string };
  }

  it('回来时两段补到一半的经历都还在，各自记着还要问什么', async () => {
    const { mtId, courseId } = await firstVisit();
    const progress = await call('experience_interview');
    const open = Object.fromEntries((progress.open_experiences ?? []).map(o => [o.id, o.follow_up_questions]));
    expect(open[mtId]).toEqual(['看板每天多少人在用？', '你一个人做的还是和组里一起？']);
    expect(open[courseId]).toEqual(['召回率提升了多少？']);
  });

  it('接着补美团那段，主张落在原经历上，不另建一条重复经历', async () => {
    const { mtId } = await firstVisit();
    await call('experience_add', { experience_id: mtId, title: '数据分析实习', claims: [{ text: '看板日活 120 人，覆盖 3 个城市运营', attribution: 'self', result_metric: '日活 120' }] });
    expect(repos.listExperiences().filter(e => e.org === '美团' || e.title === '数据分析实习')).toHaveLength(1);
    expect(repos.listClaims(mtId).find(c => c.text === '看板日活 120 人，覆盖 3 个城市运营')?.status).toBe('user_confirmed');
  });

  it('补完一段就从「没聊完」里拿掉，另一段还在', async () => {
    const { mtId, courseId } = await firstVisit();
    await call('experience_interview', { round: 'internship', status: 'done', experience_id: mtId, follow_up_questions: [] });
    const progress = await call('experience_interview');
    expect((progress.open_experiences ?? []).map(o => o.id)).toEqual([courseId]);
  });

  it('练项目讲述时冒出的新事实写进经历库待确认，不会丢', async () => {
    const { mtId } = await firstVisit();
    llm.push(JSON.stringify({ score: { structure: 3 }, improved: '……', new_claims: [{ text: '看板上线后周报人工从 4 小时降到 20 分钟', attribution: 'self', status: 'pending' }] }));
    await call('interview_project_story', { experience_id: mtId, text: '我做了一个看板，上线以后大家周报不用手工拉数了，原来要四个小时' });
    expect(repos.listClaims(mtId).map(c => c.text)).toContain('看板上线后周报人工从 4 小时降到 20 分钟');
    expect(cards().at(-1)).toMatchObject({ kind: 'claims_confirm', data: { experience_id: mtId } });
  });

  it('从代码仓库挖出的主张也出确认卡，不会悄悄躺在经历库里', async () => {
    const { mtId } = await firstVisit();
    await call('ingest_repo', { repoPath: '/tmp/dashboard', experience_id: mtId });
    expect(cards().at(-1)).toMatchObject({ kind: 'claims_confirm', data: { experience_id: mtId, claims: [{ text: '独立实现看板的增量刷新' }] } });
  });

  it.todo('〔合并冷启动分支后〕拖进来的文档导入的主张也出确认卡');
  it.todo('〔面〕说错了的主张能划掉，不会一直卡在「先确认 N 条」');
  it.todo('〔面〕主简历起草后又确认了新主张，用户知道主简历落后了');
});
