import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultResumeData, type ResumeData } from '@career/resume-studio/schema';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
// 预览依赖 react-pdf + pdf.js + canvas：单测里换成显示模板名的桩
vi.mock('./StudioPreview', () => ({ StudioPreview: ({ data }: { data: ResumeData }) => <div data-testid="preview-stub">{data.metadata.template}|{data.basics.name}</div> }));

import { apiGetJson, apiPutJson } from '@/api/apiFetch';

import { buildRich, parseRich, BulletsEditor } from './BulletsEditor';
import CareerResume from '@/pages/CareerResume';

import { ResumeWorkbench } from './ResumeWorkbench';

function doc(): ResumeData {
  const d = structuredClone(defaultResumeData);
  d.basics.name = '{{vault:profile.name}}';
  d.basics.headline = '后端开发';
  d.sections.experience.items = [{ id: 'exp_a', hidden: false, company: '字节跳动', position: '后端实习生', location: '北京', period: '2024.06 - 2024.09', website: { url: '', label: '', inlineLink: false }, description: '<ul><li><p>重构召回服务</p></li></ul>', roles: [] }] as never;
  return d;
}

function mockApi(initial = doc()) {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.endsWith('/studio')) return { ok: true, data: initial, content_updated_at: 't1', preview: { '{{vault:profile.name}}': '张三' } };
    if (path.endsWith('/resumes')) return { ok: true, masters: [{ id: 'rm_1', name: '主简历' }], tailored: [] };
    if (path.endsWith('/jobs')) return { ok: true, jobs: [] };
    return { ok: true };
  });
  vi.mocked(apiPutJson).mockResolvedValue({ ok: true, content_updated_at: 't2', preview: {} });
}

describe('简历工作台', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset(); vi.mocked(apiPutJson).mockReset();
    // jsdom 没有 ResizeObserver：给个桩（宽度 0 → 标签页布局）
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as never;
  });

  it('富文本 ⇄ 说明 + 要点：空要点在编辑中保留，行尾空格不被吃掉', () => {
    expect(parseRich('<p>一句话</p><ul><li><p>要点 A </p></li><li><p></p></li></ul>')).toEqual({ paragraphs: ['一句话'], bullets: ['要点 A ', ''] });
    expect(buildRich({ paragraphs: ['一句话'], bullets: ['a & b', ''] })).toBe('<p>一句话</p><ul><li><p>a &amp; b</p></li><li><p></p></li></ul>');
  });

  it('要点编辑：回车新起一条，空行退格删掉', () => {
    const onChange = vi.fn();
    const { rerender } = render(<BulletsEditor value="<ul><li><p>第一条</p></li></ul>" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText('描述：第 1 条'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('<ul><li><p>第一条</p></li><li><p></p></li></ul>');
    rerender(<BulletsEditor value="<ul><li><p>第一条</p></li><li><p></p></li></ul>" onChange={onChange} />);
    fireEvent.keyDown(screen.getByLabelText('描述：第 2 条'), { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith('<ul><li><p>第一条</p></li></ul>');
  });

  it('打开、编辑条目、自动保存；私密字段显示为"来自私密信息"而不是花括号', async () => {
    mockApi();
    render(<ResumeWorkbench resumeId="rm_1" />);
    expect(await screen.findByTestId('resume-workbench')).toBeInTheDocument();
    expect(screen.getByText('来自私密信息：姓名')).toBeInTheDocument();
    fireEvent.click(screen.getByText('字节跳动'));
    fireEvent.change(screen.getByLabelText('职位'), { target: { value: '后端开发实习生' } });
    expect(screen.getByTestId('studio-save-state')).toHaveTextContent('有未保存的修改');
    await waitFor(() => expect(apiPutJson).toHaveBeenCalled(), { timeout: 3000 });
    const [path, body] = vi.mocked(apiPutJson).mock.calls[0] as [string, { data: ResumeData }];
    expect(path).toBe('/api/career/resumes/rm_1/studio');
    expect((body.data.sections.experience.items[0] as { position: string }).position).toBe('后端开发实习生');
    expect(body.data.basics.name).toBe('{{vault:profile.name}}');
    await waitFor(() => expect(screen.getByTestId('studio-save-state')).toHaveTextContent('已自动保存'));
  });

  it('版式里换模板，右侧预览同时可见；撤销 / 重做', async () => {
    mockApi();
    render(<ResumeWorkbench resumeId="rm_1" />);
    await screen.findByTestId('resume-workbench');
    // 内容和预览并排：不切换就能看到预览
    expect(screen.getByTestId('preview-stub')).toHaveTextContent('onyx');
    fireEvent.click(screen.getByRole('tab', { name: '版式' }));
    fireEvent.click(screen.getByRole('button', { name: 'Azurill · 双栏' }));
    expect(screen.getByTestId('preview-stub')).toHaveTextContent('azurill');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(screen.getByTestId('preview-stub')).toHaveTextContent('onyx');
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    expect(screen.getByTestId('preview-stub')).toHaveTextContent('azurill');
  });

  it('添加经历：新条目展开编辑，删除后消失', async () => {
    mockApi();
    render(<ResumeWorkbench resumeId="rm_1" />);
    await screen.findByTestId('resume-workbench');
    fireEvent.click(screen.getByRole('button', { name: '添加经历' }));
    expect(screen.getByDisplayValue('新单位')).toBeInTheDocument();
    const deletes = screen.getAllByRole('button', { name: '删除' });
    await act(async () => { fireEvent.click(deletes[deletes.length - 1]); });
    expect(screen.queryByDisplayValue('新单位')).not.toBeInTheDocument();
  });

  it('汇总页列出每一份简历，点开进入编辑页，返回回到汇总', async () => {
    mockApi();
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.endsWith('/studio')) return { ok: true, data: doc(), content_updated_at: 't1', preview: {} };
      if (path.endsWith('/resumes')) return { ok: true, masters: [{ id: 'rm_1', name: '后端方向', direction: '后端开发', updated_at: '2026-10-09T00:00:00Z' }], tailored: [{ id: 'rt_1', master_id: 'rm_1', job_id: 'job_1', diff_confirmed_at: null, export_pdf: null, updated_at: '2026-10-10T00:00:00Z' }] };
      if (path.endsWith('/jobs')) return { ok: true, jobs: [{ id: 'job_1', company_name: '字节跳动', title: '后端开发工程师' }] };
      return { ok: true };
    });
    render(<CareerResume />);
    expect(await screen.findByText(/2 份简历/)).toBeInTheDocument();
    expect(screen.getByText('字节跳动 · 后端开发工程师')).toBeInTheDocument();
    expect(screen.getByText('待确认改动')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开简历：后端方向' }));
    expect(await screen.findByTestId('resume-workbench')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全部简历' }));
    expect(await screen.findByTestId('resume-gallery')).toBeInTheDocument();
  });
});
