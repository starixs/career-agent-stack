import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));
vi.mock('@/api/tauriClient', () => ({ getServerUrl: vi.fn(async () => 'http://127.0.0.1:3000') }));
vi.mock('@/utils/openExternal', () => ({ openExternal: vi.fn(async () => {}) }));

import { apiGetJson, apiPostJson, apiPutJson } from '@/api/apiFetch';
import { openExternal } from '@/utils/openExternal';
import CareerResume from './CareerResume';

const schema = {
  basics: { name: '张三', email: 'z@example.com' },
  education: [{ school: '乙大学', degree: '本科', major: '软件工程', start: '2019', end: '2023' }],
  experience: [{ org: '甲公司', role: '后端实习生', bullets: ['降低 P99'] }],
  projects: [],
  skills: ['TypeScript', 'SQL'],
};

const resumes = {
  ok: true,
  masters: [{ id: 'm1', name: '主简历', direction: '后端', schema_json: JSON.stringify(schema), created_at: '2024-01-01', updated_at: '2024-02-01' }],
  tailored: [{
    id: 't1', master_id: 'm1', job_id: 'j1', schema_json: JSON.stringify(schema), strength: 'keywords', diff_confirmed_at: null,
    export_pdf: null, export_docx: null, export_png: null, created_at: '2024-03-01', updated_at: '2024-03-01',
  }],
};
const jobs = { ok: true, jobs: [{ id: 'j1', source_platform: 'boss', title: '后端工程师', company_name: '丙公司' }] };

function mockGet() {
  vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
    if (path.startsWith('/api/career/resumes')) return resumes;
    if (path.startsWith('/api/career/jobs')) return jobs;
    return { ok: true };
  });
}

describe('CareerResume', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiPostJson).mockReset();
    vi.mocked(apiPutJson).mockReset();
  });

  it('空状态', async () => {
    vi.mocked(apiGetJson).mockResolvedValue({ ok: true, masters: [], tailored: [] });
    render(<CareerResume />);
    expect(await screen.findByText('还没有简历')).toBeInTheDocument();
  });

  it('渲染版本树、分区表单与 PDF 预览', async () => {
    mockGet();
    render(<CareerResume />);
    expect(await screen.findByText('主简历：主简历')).toBeInTheDocument();
    expect(screen.getByText('丙公司 · 后端工程师')).toBeInTheDocument();
    expect(screen.getByText('diff 待确认')).toBeInTheDocument();
    expect(screen.getByDisplayValue('张三')).toBeInTheDocument();
    expect(screen.getByDisplayValue('乙大学')).toBeInTheDocument();
    const frame = screen.getByTitle('简历 PDF 预览') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain('/api/career/resumes/m1/file?format=pdf');
  });

  it('修改基本信息后保存走 PUT /api/career/resumes/:id', async () => {
    mockGet();
    vi.mocked(apiPutJson).mockResolvedValue({ ok: true });
    render(<CareerResume />);
    const name = await screen.findByDisplayValue('张三');
    fireEvent.change(name, { target: { value: '李四' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(apiPutJson).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPutJson).mock.calls[0] as [string, { schema_json: string }];
    expect(path).toBe('/api/career/resumes/m1');
    expect(JSON.parse(body.schema_json).basics.name).toBe('李四');
  });

  it('导出后显示路径并可打开所在文件夹', async () => {
    mockGet();
    vi.mocked(apiPostJson).mockResolvedValue({ ok: true, path: '/data/exports/resume.pdf' });
    render(<CareerResume />);
    fireEvent.click(await screen.findByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/resumes/m1/export', { format: 'pdf' }));
    expect(await screen.findByText('/data/exports/resume.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开所在文件夹' }));
    expect(openExternal).toHaveBeenCalledWith('/data/exports');
  });
});
