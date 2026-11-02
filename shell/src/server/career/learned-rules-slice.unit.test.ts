/**
 * AI 学到的规则切面：秋招第八周（2026-10-28，周三晚上）。
 * 用户九月初开始投，已投一百多家；前几周在 Moka 上连着批准了三家（字节、快手、小红书）都没改，
 * 之后 Moka 的表就免审了。今晚翻到美团那份「已提交」，想知道：
 * - 为什么这家没让我审就提交了？依据是哪几次？
 * - AI 现在替我记着哪些「以后不用问我」？（三个月后我还记得自己放过什么吗）
 * - 我要撤回对 Moka 的免审：还没点提交的那几份要回到我手里；已经投出去的如实告诉我撤不回。
 * 页面改版、页面上改过的期望薪资（一改一批）也在这条链上。
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

import { FakeLLM, StaticKeyProvider, Vault, type Repos } from '@career/core';

import { createCareerServer } from '../tools/career-tools';
import { persistDriveOutcome } from './drive-outcome';
import { RunRegistry } from './runs';
import { executeSubmitAction } from './submit-executor';
import { LEARN_THRESHOLD, decideSubmit, getPageTrust, setAutoMode } from './submit-policy';
import { createMemoryRepos } from './test-db';
import { delegate, systemOfSync } from './trust-ledger';

const MOKA = 'https://app.mokahr.com/campus_apply/';
const MOKA_SIG = 'sig-moka-campus-v1';
const SECRET_PHONE = '13800001234';

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const h = mocks.handlers.get(name);
  if (!h) throw new Error(`工具未注册：${name}`);
  const res = await h(args);
  return { isError: !!res.isError, text: res.content[0].text };
};

type Ev = Record<string, unknown>;
const submitted = (edits: Array<{ label: string; before: string; after: string }> = []) =>
  async (_b: Ev, on: (ev: Ev) => void) => { const ev = { type: 'result', op: 'submit', result: { status: 'submitted', message: '投递成功', edits } }; on(ev); return [ev]; };

/** 一家公司的网申填到提交前：返回提交动作（由提交策略决定要不要人审）。 */
function fillUpTo(repos: Repos, company: string, opts: { url?: string; sig?: string } = {}) {
  const url = opts.url ?? `${MOKA}${company}`;
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: `j-${company}`, title: '后端开发', company_name: company, url });
  const app = repos.createApplication(job.id);
  repos.transition(app.id, 'ready'); repos.transition(app.id, 'approved');
  const pkt = repos.createPacket({ application_id: app.id, job_id: job.id, resume_pdf_sha256: 'resume-v3' });
  const fill = repos.enqueueAction('fill_form', { job_id: job.id, url, application_id: app.id, packet_id: pkt.id }, app.id);
  repos.reviewActions([fill.id], 'approved');
  repos.claimAction(fill.id);
  const task = repos.createTask({ title: company, kind: 'apply' });
  const events = [{ type: 'result', op: 'drive', result: {
    status: 'stopped_before_submit', message: 'ok', finalUrl: url, submitButton: '提交申请',
    filled: [{ fieldId: 'f0', label: '手机号', value: '{{vault:profile.phone}}', source: 'profile' }, { fieldId: 'f1', label: '期望薪资', value: '25k', source: 'answer' }],
    needsUser: [], drafts: [], mismatches: [], uploads: [],
    review: { rows: [{ fieldId: 'f0', label: '手机号', required: true, status: 'ok' }], requiredTotal: 1, requiredFilled: 1, attention: 0, formSignature: opts.sig ?? MOKA_SIG, openAnswersHash: 'open-1' },
  } }];
  const out = persistDriveOutcome({ repos, action: repos.getAction(fill.id)!, taskId: task.id, events, changed: () => undefined, mode: 'start' });
  if (out.kind !== 'done') throw new Error(`unexpected ${out.kind}`);
  return { app, submitId: out.submitActionId };
}

describe('AI 学到的规则 · 秋招第八周', () => {
  let repos: ReturnType<typeof createMemoryRepos>;
  const exec = (id: string, run = submitted()) => executeSubmitAction({ repos, broadcast: () => undefined, run }, id);

  beforeEach(async () => {
    mocks.handlers.clear();
    repos = createMemoryRepos();
    const broadcast = () => undefined;
    await createCareerServer({
      repos, vault: new Vault(repos.db, new StaticKeyProvider(Buffer.alloc(32, 7))), llm: new FakeLLM(), broadcast, sessionId: () => 'sess-1',
      runs: new RunRegistry(broadcast, () => 'sess-1'), resumeModule: async () => ({ parseResume: (x: unknown) => x as never }),
    });
  });

  /** 前几周：Moka 上三家用户本人看过、没改、批准，都投成功了。 */
  async function learnMoka() {
    for (const c of ['字节跳动', '快手', '小红书'].slice(0, LEARN_THRESHOLD)) {
      const { submitId } = fillUpTo(repos, c);
      expect(repos.getAction(submitId)!.status).toBe('pending_review');
      repos.reviewActions([submitId], 'approved', 'user');
      expect((await exec(submitId)).status).toBe('submitted');
    }
  }

  it('Moka 上连着批准三家也不会自己免审；他盖章「以后同类直接投」后，第四家直接提交，卷宗里写明凭什么', async () => {
    await learnMoka();
    expect(repos.getAction(fillUpTo(repos, '京东').submitId)!.status).toBe('pending_review');
    delegate(repos, systemOfSync(MOKA).key);
    const { app, submitId } = fillUpTo(repos, '美团');
    expect(repos.getAction(submitId)!.approved_by).toBe('delegated');
    await exec(submitId);
    const dossier = (await call('dossier_get', { application_id: app.id })).text;
    expect(dossier).toContain('以后直接投');
  });

  it('「AI 替我记着哪些不用问我」：一处列出免审的网申系统、auto 模式、页面上学到的答案', async () => {
    await learnMoka();
    delegate(repos, systemOfSync(MOKA).key);
    setAutoMode(repos, false);
    repos.saveAnswer({ question_key: '期望薪资', question_text: '期望薪资', answer: '30k', confirmed: true, source: 'page_edit', event: 'corrected', application_id: fillUpTo(repos, '京东', { url: 'https://zhaopin.jd.com/apply', sig: 'sig-jd' }).app.id });
    const res = await call('learned_rules');
    expect(res.isError).toBe(false);
    const rules = JSON.parse(res.text) as { page_trusts: Array<{ host: string; streak: number; exempt: boolean; companies: string[] }>; auto_mode: { enabled: boolean }; page_edits: Array<{ question: string; answer: string | null; company: string | null }> };
    expect(rules.page_trusts).toEqual([expect.objectContaining({ host: 'app.mokahr.com', exempt: true, companies: ['字节跳动', '快手', '小红书'] })]);
    expect(rules.auto_mode.enabled).toBe(false);
    expect(rules.page_edits).toEqual([expect.objectContaining({ question: '期望薪资', answer: '30k', company: '京东' })]);
  });

  it('私密信息不进规则清单：页面上改过的手机号只露问题、不露值', async () => {
    const { app } = fillUpTo(repos, '百度', { url: 'https://talent.baidu.com/apply', sig: 'sig-bd' });
    repos.saveAnswer({ question_key: '手机号', question_text: '手机号', answer: SECRET_PHONE, confirmed: true, source: 'page_edit', event: 'corrected', application_id: app.id });
    const res = await call('learned_rules');
    expect(res.text).not.toContain(SECRET_PHONE);
  });

  it('撤回对 Moka 的免审：还没点提交的回到待审，已投出的如实说撤不回；之后的 Moka 表都要人看', async () => {
    await learnMoka();
    delegate(repos, systemOfSync(MOKA).key);
    const done = fillUpTo(repos, '美团');
    await exec(done.submitId);
    const queued = fillUpTo(repos, '滴滴');
    expect(repos.getAction(queued.submitId)!.status).toBe('approved');

    const res = await call('learned_rules', { revoke_host: 'app.mokahr.com' });
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.text) as { revoked: number; returned_to_review: string[]; already_submitted: string[] };
    expect(out.revoked).toBeGreaterThan(0);
    expect(out.returned_to_review).toEqual(['滴滴']);
    expect(out.already_submitted).toEqual(['美团']);
    expect(repos.getAction(queued.submitId)!.status).toBe('pending_review');
    expect(getPageTrust(repos, MOKA_SIG)!.streak).toBe(0);
    expect(decideSubmit(repos, { attention: 0, formSignature: MOKA_SIG, openAnswersHash: 'open-1', resumeSha: 'resume-v3', url: MOKA }).approve).toBe(false);
  });

  it('Moka 改版（字段换了）：指纹不同，不沿用旧的免审', async () => {
    await learnMoka();
    const { submitId } = fillUpTo(repos, '拼多多', { sig: 'sig-moka-campus-v2' });
    expect(repos.getAction(submitId)!.status).toBe('pending_review');
  });

  it('页面上改过的值写回答案库时记下是哪个站点，回头能查到出处', async () => {
    const { app, submitId } = fillUpTo(repos, '网易', { url: 'https://hr.163.com/apply', sig: 'sig-163' });
    repos.reviewActions([submitId], 'approved', 'user');
    await exec(submitId, submitted([{ label: '期望薪资', before: '25k', after: '28k' }]));
    const ev = repos.db.get<{ site_host: string | null; application_id: string | null }>(`SELECT site_host, application_id FROM answer_event WHERE question_key='期望薪资'`);
    expect(ev).toMatchObject({ site_host: 'hr.163.com', application_id: app.id });
  });

  it.todo('〔面〕一家页面上改的期望薪资（网易 28k）要不要直接变成全局答案：现在会被已免审的 Moka 表照填、不再让人看（一改一批）');
  it.todo('〔面〕撤回免审是「清零重新学」还是「这个站以后都别免审」：现在清零后再批 3 次又会自动免审');
  it.todo('〔面〕免审要不要过期：三个月前学到的、之后再没人看过的规则，是否到期回到人审');
  it.todo('〔面〕关掉 auto 模式时，已经被 auto 批准、还没点提交的那几份要不要一起退回待审');
  it.todo('〔面〕「学到的规则」散在三处（kv 免审 / answer_bank 页面改动 / memory 偏好）：给用户看成同一个对象（一张规则清单）还是各回各的页');
  it.todo('〔面〕免审跨公司：Moka 等共享域名下字段相同的表算「同一界面」，在字节学到的免审会让美团（可能是目标公司）直接提交；要不要按公司分开学');
  it.todo('〔面〕规则清单在界面上的落点：资料页的一节、对话里问了才出卡，还是单独一页');
});
