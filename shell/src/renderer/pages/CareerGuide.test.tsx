import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { SKILL_POINTS, WORKBENCHES } from '@/components/career/skills/catalog';
import { CAREER_NAVIGATE_EVENT } from '@/features/career-shell/navModel';
import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerGuide from './CareerGuide';

function capture(event: string) {
  const seen: unknown[] = [];
  const off = onEvent(event, p => seen.push(p));
  return { seen, off };
}

const scoreJson = JSON.stringify({
  verdict: 'strong', score: { skills: 82, experience: 80, direction: 82, culture: 36, growth: 70, total: 77 },
  reasons: [{ dimension: 'skills', reason: '后端技术栈有实证' }],
  prefilter: { pass: true, checks: [{ item: '地点', status: 'unverified', evidence: 'JD 没写' }] },
  ask_user: ['问一下每周到岗天数'],
});
const prediction = (id: string, risk: string, statement: string, chain: string[]) => ({ id, resume_tailored_id: null, claim_id: null, statement, target_type: 'data', expected_chain_json: JSON.stringify(chain), risk, created_at: '2026-11-01' });

function mockData(data: Record<string, unknown> = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    const key = Object.keys(data).find(prefix => path.startsWith(prefix));
    return { ok: true, ...(key ? (data[key] as object) : {}) };
  });
}

const renderGuide = () => render(<CareerGuide isActive onOpenChat={vi.fn()} />);
const bench = (name: string) => within(screen.getByRole('region', { name: '工作台' })).getByRole('button', { name: new RegExp(name) });

describe('CareerGuide（功能市场）', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    resetCareerSubViews();
    mockData();
  });

  it('工作台和技能点各一组，都点得到；没有「添加 / 安装」，也没有说明性的句子和点子区', () => {
    renderGuide();
    for (const item of WORKBENCHES) expect(bench(item.name)).toBeInTheDocument();
    const points = screen.getByRole('region', { name: '交给小芽' });
    for (const item of SKILL_POINTS) expect(within(points).getByRole('button', { name: new RegExp(`^${item.name}`) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加|安装/ })).toBeNull();
    expect(screen.queryByText('点子')).toBeNull();
  });

  it('工作台点了去它那一页：面试助力、笔试助力、网申进展', () => {
    const nav = capture(CAREER_NAVIGATE_EVENT);
    renderGuide();
    fireEvent.click(bench('面试助力'));
    fireEvent.click(bench('笔试助力'));
    fireEvent.click(bench('网申进展'));
    expect(nav.seen).toEqual([
      { kind: 'career-dossier', view: 'interview' }, { kind: 'career-dossier', view: 'exam-search' }, { kind: 'career-live' },
    ]);
    nav.off();
  });

  it('工作台纸片上是他自己的真实内容：风险最高的那条追问、最近查的公司、手上的 Offer、投到哪一步', async () => {
    mockData({
      '/api/career/probe-predictions': { predictions: [prediction('p2', 'low', '负责权限模块', ['权限模型怎么设计']), prediction('p1', 'high', 'P99 从 800ms 到 200ms', ['怎么测的', '基线是什么'])] },
      '/api/career/companies': { companies: [{ id: 'c1', legal_name: '甲科技有限公司', brand_names: '[]', traffic_light: 'red', dd_report_json: JSON.stringify({ pitfalls: [{ risk: '合同主体和品牌不一致' }] }), manual_checks: '[]', updated_at: '2026-11-01' }] },
      '/api/career/offers': { offers: [{ id: 'o1', company_name: '乙公司', title: '后端', comp_json: JSON.stringify({ base: 22000, months: 15 }), deadline: null }] },
      '/api/career/dossiers': { dossiers: [{ application_id: 'a1', job_id: 'j1', company_name: '丙公司', title: '后端开发', stage: 'applied', applied_at: '2026-11-01' }] },
      '/api/career/review': { board: { counts: [23, 4, 2, 0] } },
    });
    renderGuide();
    const interview = await waitFor(() => { const card = bench('面试助力'); expect(card).toHaveTextContent('P99 从 800ms 到 200ms'); return card; });
    expect(interview).toHaveTextContent('高风险');
    expect(interview).toHaveTextContent('怎么测的');
    expect(interview).toHaveTextContent('2 条预测');
    expect(interview).not.toHaveTextContent('示例');
    expect(bench('公司调研')).toHaveTextContent('甲科技有限公司');
    expect(bench('公司调研')).toHaveTextContent('合同主体和品牌不一致');
    expect(bench('Offer 对比')).toHaveTextContent('22000 × 15');
    expect(bench('网申进展')).toHaveTextContent('丙公司');
    expect(bench('网申进展')).toHaveTextContent('投出 1 家');
    expect(bench('我的求职月')).toHaveTextContent('23');
  });

  it('还没有数据时纸片上放示例并标「示例」，不冒充他的数据，也不显示计数', async () => {
    renderGuide();
    await waitFor(() => expect(apiGetJson).toHaveBeenCalled());
    for (const name of ['面试助力', '公司调研', 'Offer 对比', '网申进展']) expect(bench(name)).toHaveTextContent('示例');
    expect(screen.queryByText(/条预测|查过 \d+ 家|投出 \d+ 家/)).toBeNull();
  });

  it('技能点：不用选东西的点了把那句话预填进对话；自己在做的点了去看结果', () => {
    const chat = capture('career:chat-suggest');
    const nav = capture(CAREER_NAVIGATE_EVENT);
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: /^聊经历/ }));
    fireEvent.click(screen.getByRole('button', { name: /^回音归类/ }));
    expect(chat.seen).toEqual([expect.objectContaining({ text: '我先口述一段实习，帮我整理进简历', mode: 'prefill' })]);
    expect(nav.seen).toEqual([{ kind: 'career-inbox' }]);
    chat.off(); nav.off();
  });

  it('要选东西的技能点点开就地展开，再点收起；同时只展开一个', () => {
    renderGuide();
    const row = screen.getByRole('button', { name: /^岗位评估/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '评估' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^招呼语/ }));
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '评估' })).toBeNull();
  });

  it('一键开始：选一个投过的岗位，点一下就带着岗位 id 发进对话，不用打字', async () => {
    mockData({ '/api/career/dossiers': { dossiers: [{ application_id: 'a1', job_id: 'j1', company_name: '甲公司', title: '后端开发', stage: 'applied' }] } });
    const chat = capture('career:chat-suggest');
    setCareerSubView('career-guide', 'job-evaluate');
    renderGuide();
    const start = screen.getByRole('button', { name: '评估' });
    expect(start).toBeDisabled();
    fireEvent.focus(screen.getByRole('combobox', { name: '岗位' }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /甲公司 · 后端开发/ }));
    fireEvent.click(start);
    expect(chat.seen).toEqual([expect.objectContaining({
      text: '帮我评估「甲公司 · 后端开发」值不值得投', mode: 'send',
      context: expect.objectContaining({ surface: 'page:career-guide:job-evaluate', refs: { job_id: 'j1' } }),
    })]);
    chat.off();
  });

  it('岗位评估的成果：结论、五项评分带依据，点开看硬门槛和投之前要确认的事', async () => {
    mockData({ '/api/career/job-evaluations': { evaluations: [{ job_id: 'j1', company_name: '甲公司', title: '后端开发', url: null, score_json: scoreJson, prefilter_json: null, updated_at: '2026-11-01' }] } });
    setCareerSubView('career-guide', 'job-evaluate');
    renderGuide();
    const row = await screen.findByRole('button', { name: /甲公司 · 后端开发/ });
    expect(within(row).getByText('很值得投')).toBeInTheDocument();
    expect(screen.queryByText('后端技术栈有实证')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText('后端技术栈有实证')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '公司 36' })).toBeInTheDocument();
    expect(screen.getByText('JD 没写', { selector: 'span.inline-flex' })).toBeInTheDocument();
    expect(screen.getByText('问一下每周到岗天数')).toBeInTheDocument();
  });

  it('方向探索的成果：依据和拿不准的地方分开列，状态可以自己标', async () => {
    const direction = { id: 'd1', name: '后端基础设施', status: 'candidate', rationale_json: JSON.stringify({ fit_reasons: [{ reason: '做过权限模块' }], uncertainty: ['岗位数量少'] }), created_at: '2026-09-01', updated_at: '2026-09-01' };
    mockData({ '/api/career/directions': { directions: [direction] } });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    setCareerSubView('career-guide', 'direction-explore');
    renderGuide();
    fireEvent.click(await screen.findByRole('button', { name: /后端基础设施/ }));
    expect(screen.getByText('做过权限模块')).toBeInTheDocument();
    expect(screen.getByText('岗位数量少')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '设为已选' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/directions/d1/status', { status: 'chosen' }));
  });
});
