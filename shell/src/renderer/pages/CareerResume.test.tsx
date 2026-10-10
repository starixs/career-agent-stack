import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultResumeData } from '@career/resume-studio/schema';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/components/resume-workbench/StudioPreview', () => ({ StudioPreview: () => <div data-testid="preview-stub" /> }));

import { apiGetJson } from '@/api/apiFetch';

import CareerResume from './CareerResume';

// 简历页先是汇总（每一份的成品缩略图），点开进入编辑页；指定 id 时直接打开那一份。

describe('CareerResume', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as never;
  });

  it('还没有简历：提示在对话里生成', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => (path.endsWith('/resumes') ? { ok: true, masters: [], tailored: [] } : { ok: true, jobs: [] }));
    render(<CareerResume embedded />);
    expect(await screen.findByText(/帮我生成主简历/)).toBeInTheDocument();
  });

  it('有简历：先看到汇总，点开进入编辑页', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.endsWith('/resumes')) return { ok: true, masters: [{ id: 'rm_1', name: '主简历' }], tailored: [] };
      if (path.endsWith('/rm_1/studio')) return { ok: true, data: structuredClone(defaultResumeData), content_updated_at: 't', preview: {} };
      return { ok: true, jobs: [] };
    });
    render(<CareerResume embedded />);
    fireEvent.click(await screen.findByRole('button', { name: '打开简历：主简历' }));
    expect(await screen.findByTestId('resume-workbench')).toBeInTheDocument();
    expect(apiGetJson).toHaveBeenCalledWith('/api/career/resumes/rm_1/studio');
  });

  it('指定 id（聊天旁侧栏）：直接打开那一份', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.endsWith('/resumes')) return { ok: true, masters: [{ id: 'rm_1', name: '主简历' }], tailored: [] };
      if (path.endsWith('/rm_1/studio')) return { ok: true, data: structuredClone(defaultResumeData), content_updated_at: 't', preview: {} };
      return { ok: true, jobs: [] };
    });
    render(<CareerResume initialResumeId="rm_1" />);
    expect(await screen.findByTestId('resume-workbench')).toBeInTheDocument();
  });
});
