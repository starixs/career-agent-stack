import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import CareerResearch from './CareerResearch';

const companies = [{
  id: 'c1', legal_name: '丙科技有限公司', brand_names: JSON.stringify(['丙公司']), traffic_light: 'yellow',
  dd_report_json: JSON.stringify({ overview: '做企业服务', risk: ['近期裁员传闻'] }),
  manual_checks: JSON.stringify(['核实社保缴纳主体', { item: '确认 base 地', done: true }]), updated_at: '2026-09-30',
}];
const directions = [
  { id: 'd1', name: '后端基础设施', status: 'candidate', rationale_json: JSON.stringify({ reason: '经历匹配', uncertainty: '市场需求收缩' }), created_at: '2026-09-01', updated_at: '2026-09-01' },
  { id: 'd2', name: '数据工程', status: 'dropped', rationale_json: null, created_at: '2026-09-01', updated_at: '2026-09-01' },
];
const gapPlans = [{
  id: 'g1', job_id: 'j1', direction_id: null,
  gaps_json: JSON.stringify({ have: ['Go'], need_evidence: ['K8s 运维'], missing: ['Rust'] }),
  actions_json: JSON.stringify([{ title: '写一个 K8s operator demo', acceptance: '仓库可运行', due: '2026-10-20' }]),
  created_at: '2026-09-20',
}];
const jobs = [{ id: 'j1', source_platform: 'boss', title: '基础架构工程师', company_name: '丙公司' }];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/companies')) return { ok: true, companies: empty ? [] : companies };
    if (path.startsWith('/api/career/directions')) return { ok: true, directions: empty ? [] : directions };
    if (path.startsWith('/api/career/gap-plans')) return { ok: true, gapPlans: empty ? [] : gapPlans };
    if (path.startsWith('/api/career/jobs')) return { ok: true, jobs: empty ? [] : jobs };
    return { ok: true };
  });
}

describe('CareerResearch', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('空状态', async () => {
    mockGet(true);
    render(<CareerResearch />);
    expect(await screen.findByText('还没有公司研究')).toBeInTheDocument();
    expect(screen.getByText('还没有候选方向')).toBeInTheDocument();
    expect(screen.getByText('还没有差距计划')).toBeInTheDocument();
  });

  it('渲染公司（红绿灯 / 报告折叠 / 核实清单）、方向与差距计划', async () => {
    mockGet();
    render(<CareerResearch />);
    expect(await screen.findByText('丙科技有限公司')).toBeInTheDocument();
    expect(screen.getByText('黄灯')).toBeInTheDocument();
    expect(screen.queryByText('做企业服务')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /九段报告/ }));
    expect(screen.getByText('做企业服务')).toBeInTheDocument();
    expect(screen.getByLabelText('核实社保缴纳主体')).not.toBeChecked();
    expect(screen.getByLabelText('确认 base 地')).toBeChecked();
    expect(screen.getByText('后端基础设施')).toBeInTheDocument();
    expect(screen.getByText('市场需求收缩')).toBeInTheDocument();
    expect(screen.getByText('丙公司 · 基础架构工程师')).toBeInTheDocument();
    expect(screen.getByText('K8s 运维')).toBeInTheDocument();
    expect(screen.getByText('写一个 K8s operator demo')).toBeInTheDocument();
  });

  it('切换方向状态调用 directions/:id/status', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true });
    render(<CareerResearch />);
    await screen.findByText('后端基础设施');
    fireEvent.click(screen.getAllByRole('button', { name: '设为已选' })[0]);
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/directions/d1/status', { status: 'chosen' }));
  });
});
