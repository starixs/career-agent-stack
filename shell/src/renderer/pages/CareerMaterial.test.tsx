import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/pages/CareerExperience', () => ({ default: () => <div data-testid="embedded-experience" /> }));
vi.mock('@/pages/CareerResume', () => ({ default: () => <div data-testid="embedded-resume" /> }));

import { apiDelete, apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import { emitEvent, onEvent } from '@/api/eventBus';
import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerMaterial from './CareerMaterial';

const materials = [
  { id: 'm1', kind: 'why_company', title: '为什么选丙公司', question_key: null, content: '看重丙公司在基础设施上的长期投入，以及我做过的网关项目和岗位高度匹配。', length_variant: null, claim_ids_json: '[]', tags_json: '[]', company_scope: '丙公司', confirmed: 1, created_at: '2026-09-20', updated_at: '2026-09-21' },
  { id: 'm2', kind: 'self_intro', title: '一分钟自我介绍', question_key: null, content: '我是张三，后端方向。', length_variant: '1min', claim_ids_json: '[]', tags_json: '[]', company_scope: null, confirmed: 0, created_at: '2026-09-22', updated_at: '2026-09-22' },
];
const uses = [
  { id: 'u1', material_id: 'm1', application_id: 'a1', job_id: 'j1', company_name: '丙公司', context: 'form', content_snapshot: '看重丙公司…', used_at: '2026-09-23' },
  { id: 'u2', material_id: 'm1', application_id: 'a2', job_id: 'j2', company_name: '丁公司', context: 'mail', content_snapshot: '看重丁公司…', used_at: '2026-09-24' },
];

function mockGet(empty = false) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/materials/uses')) return { ok: true, uses: empty ? [] : uses };
    if (path.startsWith('/api/career/materials')) return { ok: true, materials: empty ? [] : materials };
    return { ok: true };
  });
}

describe('CareerMaterial', () => {
  beforeEach(() => {
    resetCareerSubViews();
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiPutJson).mockReset();
    vi.mocked(apiDelete).mockReset();
  });

  it('空状态', async () => {
    mockGet(true);
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('说法库还是空的')).toBeInTheDocument();
    expect(screen.getByText('助理起草并经你确认的说法会存在这里；网申、邮件、面试里用过的地方都会记录')).toBeInTheDocument();
  });

  it('渲染素材卡片：类型 / 确认态 / 适用公司 / 用过几次，展开看对谁说过', async () => {
    mockGet();
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    expect(await screen.findByText('为什么选丙公司')).toBeInTheDocument();
    expect(screen.getByText('一分钟自我介绍')).toBeInTheDocument();
    expect(screen.getByText('已确认')).toBeInTheDocument();
    expect(screen.getByText('草稿')).toBeInTheDocument();
    expect(screen.getByText('丙公司')).toBeInTheDocument();
    expect(screen.getByText('1min')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '对谁说过（2）' }));
    expect(screen.getByText('丁公司')).toBeInTheDocument();
    expect(screen.getByText('mail')).toBeInTheDocument();
  });

  it('手动新增提交到 materials', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, material: { id: 'm3' } });
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    await screen.findByText('为什么选丙公司');
    fireEvent.click(screen.getByRole('button', { name: '手动新增' }));
    fireEvent.click(screen.getByLabelText('素材类型'));
    fireEvent.click(screen.getByRole('button', { name: '项目故事' }));
    fireEvent.change(screen.getByLabelText('素材标题'), { target: { value: '网关项目 STAR' } });
    fireEvent.change(screen.getByLabelText('素材内容'), { target: { value: '背景：…' } });
    fireEvent.click(screen.getByRole('button', { name: '标为已确认' }));
    fireEvent.click(screen.getByRole('button', { name: '保存素材' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/materials', {
      kind: 'project_story', title: '网关项目 STAR', content: '背景：…', company_scope: null, confirmed: true,
    }));
  });

  it('确认 / 取消确认 / 编辑 / 删除', async () => {
    mockGet();
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true, material: {} });
    vi.mocked(apiDelete).mockResolvedValue({ ok: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    await screen.findByText('为什么选丙公司');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledWith('/api/career/materials/m2', { confirmed: true }));
    fireEvent.click(screen.getByRole('button', { name: '取消确认' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledWith('/api/career/materials/m1', { confirmed: false }));

    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]);
    fireEvent.change(screen.getByLabelText('编辑标题'), { target: { value: '为什么选丙公司（改）' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledWith('/api/career/materials/m1', { title: '为什么选丙公司（改）', content: materials[0].content }));

    fireEvent.click(screen.getAllByRole('button', { name: '删除' })[1]);
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith('/api/career/materials/m2'));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('按类型筛选', async () => {
    mockGet();
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    await screen.findByText('为什么选丙公司');
    fireEvent.click(screen.getByRole('button', { name: '自我介绍 1' }));
    expect(screen.queryByText('为什么选丙公司')).not.toBeInTheDocument();
    expect(screen.getByText('一分钟自我介绍')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '职业规划 0' }));
    expect(screen.getByText('这个类型下还没有素材。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全部 2' }));
    expect(screen.getByText('为什么选丙公司')).toBeInTheDocument();
  });

  it('让助理做的按钮带 surface material 发进对话', async () => {
    mockGet();
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    await screen.findByText('为什么选丙公司');
    const seen: Array<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string; refs?: Record<string, unknown> } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(screen.getByRole('button', { name: '帮我写一段“为什么选择我们”' }));
    fireEvent.click(screen.getAllByRole('button', { name: '按这个素材给某公司改一版' })[1]);
    expect(seen).toHaveLength(2);
    expect(seen[0].context).toMatchObject({ surface: 'material' });
    expect(seen[1].context).toMatchObject({ surface: 'material', refs: { material_id: 'm2' } });
    off();
  });

  it('焦点：素材 id 高亮，非素材 id 切到简历视图；切换视图渲染嵌入页', async () => {
    mockGet();
    render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
    await screen.findByText('为什么选丙公司');
    act(() => { emitEvent('career:focus', { surface: 'material', id: 'm2' }); });
    expect(document.getElementById('material-m2')?.querySelector('.ring-2')).not.toBeNull();
    act(() => { emitEvent('career:focus', { surface: 'material', id: 'resume-master-1' }); });
    expect(await screen.findByTestId('embedded-resume')).toBeInTheDocument();
    act(() => { setCareerSubView('career-material', 'experience'); });
    expect(await screen.findByTestId('embedded-experience')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '经历' })).toBeInTheDocument();
    act(() => { setCareerSubView('career-material', 'library'); });
    expect(await screen.findByText('为什么选丙公司')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '常用表达' })).toBeInTheDocument();
  });
});
