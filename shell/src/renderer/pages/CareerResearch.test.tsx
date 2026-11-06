import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import CareerResearch from './CareerResearch';

// 公司调研技能（company-research）的整份输出：页面按「要留意的 → 面试时可以问 → 红线核验 → 要你自己核实的 → 风险信号」摆出来
const report = {
  entity: { legal_name: '甲科技（杭州）股份有限公司', brand_names: ['甲科技'], confidence: 'high' },
  basic: { founded: '2014 年', status: '存续' },
  red_lines: [
    { id: 1, name: '失信被执行人', status: 'clean', evidence: [] },
    { id: 4, name: '近 1 年劳动仲裁频繁', status: 'hit', evidence: [{ title: '裁判文书公开记录', url: 'https://example.com/case', source_level: 'official' }] },
    { id: 7, name: '社保欠缴被公示', status: 'unverified', evidence: [] },
  ],
  signals: [{ category: '经营恶化', keyword: '裁员', hits: 1, strong: [{ title: '论坛帖子', url: 'https://example.com/post' }] }, { category: '欠薪', keyword: '拖欠工资', hits: 0, strong: [] }],
  traffic_light: 'red',
  pitfalls: [{ risk: '校招岗位可能挂在子公司签约', evidence: '签约主体和品牌名不一致', ask_in_interview: '劳动合同和哪家主体签？' }],
  interview_questions: ['团队现在有多少人？'],
  manual_required: [{ item: '在企业信用公示系统核对经营状态', entry_url: 'https://www.gsxt.gov.cn', why: '官方渠道要验证码' }],
};
const companies = [
  // 新报告：人工核实清单在报告里的 manual_required；库里的 manual_checks 此前因为字段名读错一直是空的
  { id: 'c1', legal_name: '甲科技（杭州）股份有限公司', brand_names: JSON.stringify(['甲科技']), traffic_light: 'red', dd_report_json: JSON.stringify(report), manual_checks: '[]', updated_at: '2026-11-01' },
  // 旧数据：报告是自由分段，核实清单单独存
  { id: 'c2', legal_name: '丙科技有限公司', brand_names: JSON.stringify(['丙公司']), traffic_light: 'yellow', dd_report_json: JSON.stringify({ overview: '做企业服务' }), manual_checks: JSON.stringify(['核实社保缴纳主体', { item: '确认 base 地', done: true }]), updated_at: '2026-09-30' },
];

function mockGet(list: unknown[] = companies, dossiers: unknown[] = []) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/companies')) return { ok: true, companies: list };
    if (path.startsWith('/api/career/dossiers')) return { ok: true, dossiers };
    return { ok: true };
  });
}

describe('CareerResearch（公司调研工作台）', () => {
  beforeEach(() => { vi.mocked(apiGetJson).mockReset(); });

  it('还没查过任何公司：「选一家、查这家」照常能用，下面用预设的一家把查出来的样子摆出来（不写「示例」），不报错', async () => {
    mockGet([]);
    render(<CareerResearch />);
    expect(await screen.findByRole('combobox', { name: '公司' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查这家' })).toBeDisabled();
    const sample = await screen.findByTestId('sample');
    expect(screen.queryByText(/示例/)).toBeNull();
    const list = within(sample).getByRole('list', { name: '查过的公司' });
    // 只摆一家的初始效果，不把红黄绿三种都摆出来
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(sample).getByRole('heading', { name: '星河科技（杭州）股份有限公司' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('左边是查过的公司和红黄绿灯，右边是选中那家的报告：要留意的每条贴着面试时怎么问', async () => {
    mockGet();
    render(<CareerResearch />);
    const list = await screen.findByRole('list', { name: '查过的公司' });
    expect(screen.queryByTestId('sample')).toBeNull();
    expect(within(list).getByText('红灯')).toBeInTheDocument();
    expect(within(list).getByText('黄灯')).toBeInTheDocument();
    expect(screen.getByText(/成立于 2014 年 · 存续/)).toBeInTheDocument();
    expect(screen.getByText('校招岗位可能挂在子公司签约')).toBeInTheDocument();
    expect(screen.getByText('劳动合同和哪家主体签？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /面试时问/ }));
    expect(screen.getByText('团队现在有多少人？')).toBeInTheDocument();
  });

  it('两层：上面是一句话结论、要点和科普（公司是做什么的、岗位来了做什么），下面的分项一次只看一项', async () => {
    const full = {
      ...report,
      summary: { one_line: '可以投，签约主体要问清楚', points: ['主体清楚', '可能挂在子公司签约'] },
      intro: { business: '做企业用的数据平台，按年收订阅费', sources: [{ title: '公司官网', url: 'https://example.com/about' }], role: '在平台团队写后端接口' },
    };
    mockGet([{ ...companies[0], dd_report_json: JSON.stringify(full) }]);
    render(<CareerResearch />);
    expect(await screen.findByText('可以投，签约主体要问清楚')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '要点' })).getAllByRole('listitem')).toHaveLength(2);
    const intro = screen.getByRole('region', { name: '科普' });
    expect(within(intro).getByRole('heading', { name: '这家公司是做什么的' })).toBeInTheDocument();
    expect(within(intro).getByText('做企业用的数据平台，按年收订阅费')).toBeInTheDocument();
    expect(within(intro).getByRole('link', { name: '公司官网' })).toHaveAttribute('href', 'https://example.com/about');
    expect(within(intro).getByRole('heading', { name: '这个岗位来了做什么' })).toBeInTheDocument();
    expect(within(intro).getByText('在平台团队写后端接口')).toBeInTheDocument();
    // 第二层默认摊开第一项；别的项点了才出现
    expect(screen.getByRole('tab', { name: /要留意/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('团队现在有多少人？')).toBeNull();
  });

  it('红线核验：命中带出处；查不了的写「没法确认」，搜不到的写「没查到记录」，都不写成没问题', async () => {
    mockGet();
    render(<CareerResearch />);
    const tab = await screen.findByRole('tab', { name: /红线命中/ });
    expect(tab).toHaveTextContent('1');
    fireEvent.click(tab);
    // 每条红线前一个状态记号
    for (const label of ['命中', '没查到记录', '没法确认']) expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '裁判文书公开记录' })).toHaveAttribute('href', 'https://example.com/case');
    // 风险信号只列有命中的
    fireEvent.click(screen.getByRole('tab', { name: /风险信号/ }));
    expect(screen.getByText('经营恶化（裁员）')).toBeInTheDocument();
    expect(screen.queryByText(/欠薪/)).toBeNull();
  });

  it('人工核实清单从报告的 manual_required 里读出来（回归：以前读错字段，这一栏永远是空的）', async () => {
    mockGet();
    render(<CareerResearch />);
    fireEvent.click(await screen.findByRole('tab', { name: /自己核实/ }));
    expect(screen.getByRole('link', { name: '在企业信用公示系统核对经营状态' })).toHaveAttribute('href', 'https://www.gsxt.gov.cn');
    expect(screen.getByText('官方渠道要验证码')).toBeInTheDocument();
  });

  it('旧数据：自由分段的报告原样列出，单独存的核实清单照常显示', async () => {
    mockGet();
    render(<CareerResearch />);
    fireEvent.click(await screen.findByRole('button', { name: /丙科技有限公司/ }));
    expect(screen.getByText('做企业服务')).toBeInTheDocument();
    expect(screen.getByText('核实社保缴纳主体')).toBeInTheDocument();
    expect(screen.getByText('确认 base 地')).toBeInTheDocument();
  });

  it('选一家投过的公司，点一下就发进对话去查，不用打字', async () => {
    mockGet([], [{ application_id: 'a1', job_id: 'j1', company_name: '乙公司', title: '后端开发', stage: 'applied' }]);
    const said: Array<{ text: string; mode?: string; context?: { surface?: string } }> = [];
    const off = onEvent('career:chat-suggest', (event: (typeof said)[number]) => { said.push(event); });
    render(<CareerResearch />);
    fireEvent.focus(await screen.findByRole('combobox', { name: '公司' }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: '乙公司' }));
    fireEvent.click(screen.getByRole('button', { name: '查这家' }));
    expect(said).toEqual([expect.objectContaining({ text: '帮我查一下「乙公司」这家公司靠不靠谱', mode: 'send', context: expect.objectContaining({ surface: 'page:career-review:research' }) })]);
    off();
  });
});
