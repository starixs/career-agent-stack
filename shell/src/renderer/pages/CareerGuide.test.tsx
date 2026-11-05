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

function mockData(data: Record<string, unknown> = {}) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    const key = Object.keys(data).find(prefix => path.startsWith(prefix));
    return { ok: true, ...(key ? (data[key] as object) : {}) };
  });
}

const renderGuide = () => render(<CareerGuide isActive onOpenChat={vi.fn()} />);
const bench = (name: string) => within(screen.getByRole('region', { name: '工作台' })).getByRole('button', { name: new RegExp(`^${name}`) });
const point = (name: string) => within(screen.getByRole('region', { name: '交给小芽' })).getByRole('button', { name: new RegExp(`^${name}`) });

describe('CareerGuide（功能市场）', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    resetCareerSubViews();
    mockData();
  });

  it('工作台和技能点各一组卡片，每张一幅插画加名字；没有「添加 / 安装」和点子区', () => {
    const view = renderGuide();
    for (const item of WORKBENCHES) expect(bench(item.name)).toBeInTheDocument();
    for (const item of SKILL_POINTS) expect(point(item.name)).toBeInTheDocument();
    expect(view.container.querySelectorAll('button svg[viewBox="0 0 120 80"]')).toHaveLength(WORKBENCHES.length + SKILL_POINTS.length);
    expect(screen.queryByRole('button', { name: /添加|安装/ })).toBeNull();
    expect(screen.queryByText('点子')).toBeNull();
  });

  it('工作台卡片点了去它那一页：面试助力、笔试助力、网申进展', () => {
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

  it('卡片上不放「做过几次」这类计数：有数据也只有名字', async () => {
    mockData({ '/api/career/probe-predictions': { predictions: [{ id: 'p1' }, { id: 'p2' }] }, '/api/career/companies': { companies: [{ id: 'c1' }] } });
    renderGuide();
    expect(bench('面试助力')).toHaveTextContent(/^面试助力$/);
    expect(bench('公司调研')).toHaveTextContent(/^公司调研$/);
    expect(apiGetJson).not.toHaveBeenCalled();
  });

  it('技能点：不用选东西的点了把那句话预填进对话；自己在做的点了去看结果', () => {
    const chat = capture('career:chat-suggest');
    const nav = capture(CAREER_NAVIGATE_EVENT);
    renderGuide();
    fireEvent.click(point('聊经历'));
    fireEvent.click(point('回音归类'));
    expect(chat.seen).toEqual([expect.objectContaining({ text: '我先口述一段实习，帮我整理进简历', mode: 'prefill' })]);
    expect(nav.seen).toEqual([{ kind: 'career-inbox' }]);
    chat.off(); nav.off();
  });

  it('要选东西或有成果的技能点点开原地换成详情，左上角返回', () => {
    renderGuide();
    fireEvent.click(point('岗位评估'));
    expect(screen.getByRole('heading', { name: '岗位评估' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '评估' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '工作台' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '功能市场' }));
    expect(screen.getByRole('region', { name: '工作台' })).toBeInTheDocument();
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

  it('岗位评估的成果：一枚结论章；点开是五项雷达图、每项的分数和依据、硬门槛记号、投之前要确认的事', async () => {
    mockData({ '/api/career/job-evaluations': { evaluations: [{ job_id: 'j1', company_name: '甲公司', title: '后端开发', url: null, score_json: scoreJson, prefilter_json: null, updated_at: '2026-11-01' }] } });
    setCareerSubView('career-guide', 'job-evaluate');
    renderGuide();
    const row = await screen.findByRole('button', { name: /甲公司 · 后端开发/ });
    expect(within(row).getByText('很值得投')).toBeInTheDocument();
    expect(screen.queryByText('后端技术栈有实证')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByRole('img', { name: '五项评分：技能 82，经历 80，方向 82，公司 36，成长 70' })).toBeInTheDocument();
    expect(screen.getByText('后端技术栈有实证')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: '地点：JD 没写' })).toBeInTheDocument();
    expect(screen.getByText('问一下每周到岗天数')).toBeInTheDocument();
  });

  it('方向探索的成果：依据和拿不准的地方分开列，状态可以自己标', async () => {
    const direction = { id: 'd1', name: '后端基础设施', status: 'candidate', rationale_json: JSON.stringify({ fit_reasons: [{ reason: '做过权限模块' }], uncertainty: ['岗位数量少'] }), created_at: '2026-09-01', updated_at: '2026-09-01' };
    mockData({ '/api/career/directions': { directions: [direction] } });
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    setCareerSubView('career-guide', 'direction-explore');
    renderGuide();
    // 方向并排成路牌，第一个默认摊开；对得上几条是一排圆点
    const card = await screen.findByRole('tab', { name: '后端基础设施：候选' });
    expect(card).toHaveAttribute('aria-selected', 'true');
    expect(within(card).getByRole('img', { name: '对得上 1 条' })).toBeInTheDocument();
    expect(screen.getByText('做过权限模块')).toBeInTheDocument();
    expect(screen.getByText('岗位数量少')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '设为已选' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/directions/d1/status', { status: 'chosen' }));
  });
});
