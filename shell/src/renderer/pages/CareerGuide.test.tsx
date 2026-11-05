import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { SKILL_POINTS, WORKBENCHES } from '@/components/career/skills/catalog';
import { CAREER_NAVIGATE_EVENT } from '@/features/career-shell/navModel';
import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerGuide, { IDEAS } from './CareerGuide';

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

function mockData(data: Record<string, unknown> = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    const key = Object.keys(data).find(prefix => path.startsWith(prefix));
    return { ok: true, ...(key ? (data[key] as object) : {}) };
  });
}

const renderGuide = () => render(<CareerGuide isActive onOpenChat={vi.fn()} />);

describe('CareerGuide（功能市场）', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    resetCareerSubViews();
    mockData();
  });

  it('工作台和技能点各一组卡片，没有「添加 / 安装」；点子一行一个', () => {
    renderGuide();
    const benches = screen.getByRole('region', { name: '工作台' });
    for (const item of WORKBENCHES) expect(within(benches).getByRole('button', { name: new RegExp(`^${item.name}`) })).toBeInTheDocument();
    const points = screen.getByRole('region', { name: '交给小芽' });
    for (const item of SKILL_POINTS) expect(within(points).getByRole('button', { name: new RegExp(`^${item.name}`) })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /添加|安装/ })).toBeNull();
    for (const idea of IDEAS) expect(screen.getByText(idea.text)).toBeInTheDocument();
  });

  it('工作台卡片点了去它那一页：面试助力、笔试助力、网申进展', () => {
    const nav = capture(CAREER_NAVIGATE_EVENT);
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: /^面试助力/ }));
    fireEvent.click(screen.getByRole('button', { name: /^笔试助力/ }));
    fireEvent.click(screen.getByRole('button', { name: /^网申进展/ }));
    expect(nav.seen).toEqual([
      { kind: 'career-dossier', view: 'interview' }, { kind: 'career-dossier', view: 'exam-search' }, { kind: 'career-live' },
    ]);
    nav.off();
  });

  it('卡片上的计数是库里的真数；没有就不显示', async () => {
    mockData({
      '/api/career/probe-predictions': { predictions: [{ id: 'p1' }, { id: 'p2' }] },
      '/api/career/companies': { companies: [{ id: 'c1' }] },
    });
    renderGuide();
    expect(await screen.findByText('2 条追问预测')).toBeInTheDocument();
    expect(screen.getByText('查过 1 家')).toBeInTheDocument();
    expect(screen.queryByText(/^\d+ 个 Offer$/)).toBeNull();
  });

  it('技能点点开原地换成详情：特别在哪、怎么说、返回', () => {
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: /^岗位评估/ }));
    expect(screen.getByRole('heading', { name: '岗位评估' })).toBeInTheDocument();
    const special = screen.getByRole('list', { name: '小芽会这样做' });
    expect(within(special).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('region', { name: '工作台' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '功能市场' }));
    expect(screen.getByRole('region', { name: '工作台' })).toBeInTheDocument();
  });

  it('详情里那句话点了预填进对话输入框，不直接发送', () => {
    const chat = capture('career:chat-suggest');
    setCareerSubView('career-guide', 'job-evaluate');
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: '「帮我评估这个岗位，JD 是：」' }));
    expect(chat.seen).toEqual([expect.objectContaining({ text: '帮我评估这个岗位，JD 是：', mode: 'prefill' })]);
    chat.off();
  });

  it('一键开始：选一个投过的岗位，点一下就带着岗位 id 发进对话，不用打字', async () => {
    mockData({ '/api/career/dossiers': { dossiers: [{ application_id: 'a1', job_id: 'j1', company_name: '甲公司', title: '后端开发', stage: 'applied' }] } });
    const chat = capture('career:chat-suggest');
    setCareerSubView('career-guide', 'job-evaluate');
    renderGuide();
    const start = screen.getByRole('button', { name: '评估这个岗位' });
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

  it('不用选东西的技能点直接开始；自动在做的给去看结果的入口', () => {
    const chat = capture('career:chat-suggest');
    const nav = capture(CAREER_NAVIGATE_EVENT);
    setCareerSubView('career-guide', 'direction-explore');
    const view = renderGuide();
    fireEvent.click(screen.getByRole('button', { name: '帮我看看方向' }));
    expect(chat.seen).toEqual([expect.objectContaining({ text: '帮我看看还有哪些方向适合我', mode: 'send' })]);
    view.unmount();
    setCareerSubView('career-guide', 'inbox-triage');
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: '看通知' }));
    expect(nav.seen).toEqual([{ kind: 'career-inbox' }]);
    chat.off(); nav.off();
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

  it('点子：预填一句话，或直接打开「我的求职月」', () => {
    const chat = capture('career:chat-suggest');
    const nav = capture(CAREER_NAVIGATE_EVENT);
    renderGuide();
    fireEvent.click(screen.getByRole('button', { name: '摊开卷宗' }));
    fireEvent.click(screen.getByRole('button', { name: '看我的求职月' }));
    expect(chat.seen).toEqual([expect.objectContaining({ text: '我明天面试，把这家公司的卷宗摊开：', mode: 'prefill' })]);
    expect(nav.seen).toEqual([{ kind: 'career-review' }]);
    chat.off(); nav.off();
  });
});
