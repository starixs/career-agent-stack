import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import CareerInterview from './CareerInterview';

const interviews = [
  {
    id: 'i1', application_id: null, company_name: '丙公司', title: '后端工程师', round: 'first', date: '2026-09-28',
    interviewer_role_guess: '技术负责人', transcript: '问了限流的实现', tags_json: JSON.stringify(['限流', '系统设计']),
    retro_json: JSON.stringify({ went_well: ['表达清晰'], improve: ['量化结果'] }), result: 'no_feedback_inferred', result_source: 'inferred',
    created_at: '2026-09-28', updated_at: '2026-09-28',
  },
  {
    id: 'i2', application_id: null, company_name: '丁公司', title: '算法工程师', round: 'hr', date: '2026-09-20',
    interviewer_role_guess: null, transcript: null, tags_json: '[]', retro_json: null, result: 'advanced', result_source: 'official',
    created_at: '2026-09-20', updated_at: '2026-09-20',
  },
];
const mocks = [{ id: 'm1', job_id: null, resume_tailored_id: null, mode: 'probe', company_type: '大厂', round: 'first', turns_json: JSON.stringify([{}, {}]), report_json: JSON.stringify({ score: 7 }), created_at: '2026-09-25', updated_at: '2026-09-25' }];
const predictions = [{ id: 'p1', resume_tailored_id: null, claim_id: null, statement: 'P99 从 800ms 到 200ms 的具体手段', target_type: 'data', expected_chain_json: JSON.stringify(['怎么测的', '基线是什么']), risk: 'high', created_at: '2026-09-25' }];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/interviews')) return { ok: true, interviews: empty ? [] : interviews };
    if (path.startsWith('/api/career/mock-interviews')) return { ok: true, mockInterviews: empty ? [] : mocks };
    if (path.startsWith('/api/career/probe-predictions')) {
      if (empty) throw new Error('HTTP 404');
      return { ok: true, predictions };
    }
    return { ok: true };
  });
}

describe('CareerInterview', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
  });

  it('空状态（预测路由 404 也不报错）', async () => {
    mockGet(true);
    render(<CareerInterview />);
    expect(await screen.findByText('还没有面试记录')).toBeInTheDocument();
    expect(screen.getByText(/还没有预测/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('渲染记录列表（结果与来源徽标）、详情、模拟面试与预测', async () => {
    mockGet();
    render(<CareerInterview />);
    expect((await screen.findAllByText('无反馈（推测）')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('推测').length).toBeGreaterThan(0);
    expect(screen.getByText('进入下一轮')).toBeInTheDocument();
    expect(screen.getByText('问了限流的实现')).toBeInTheDocument();
    expect(screen.getByText('表达清晰')).toBeInTheDocument();
    expect(screen.getByText('限流')).toBeInTheDocument();
    expect(screen.getByText('深挖追问 · 一面')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看报告' }));
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('P99 从 800ms 到 200ms 的具体手段')).toBeInTheDocument();
    expect(screen.getByText('怎么测的')).toBeInTheDocument();
  });

  it('新建记录调用 POST /api/career/interviews', async () => {
    mockGet(true);
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, interview: { id: 'i9' } });
    render(<CareerInterview />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记录' }));
    fireEvent.change(screen.getByLabelText('公司'), { target: { value: '戊公司' } });
    fireEvent.click(screen.getByLabelText('轮次'));
    fireEvent.click(screen.getByRole('button', { name: '终面' }));
    fireEvent.change(screen.getByLabelText('标签（逗号分隔）'), { target: { value: '系统设计, 项目' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPostJson).mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/career/interviews');
    expect(body).toMatchObject({ company_name: '戊公司', round: 'final', result: 'none', result_source: 'none' });
    expect(JSON.parse(body.tags_json as string)).toEqual(['系统设计', '项目']);
  });
});
