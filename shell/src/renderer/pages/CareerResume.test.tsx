import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultResumeData } from '@career/resume-studio/schema';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/components/resume-workbench/StudioPreview', () => ({ StudioPreview: () => <div data-testid="preview-stub" /> }));

import { apiGetJson } from '@/api/apiFetch';

import CareerResume from './CareerResume';

// 简历页 = 简历工作台：没有简历时给出下一步；有简历时打开第一份（或指定的那份）。

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

  it('有简历：打开第一份主简历的工作台', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.endsWith('/resumes')) return { ok: true, masters: [{ id: 'rm_1', name: '主简历' }], tailored: [] };
      if (path.endsWith('/rm_1/studio')) return { ok: true, data: structuredClone(defaultResumeData), content_updated_at: 't', preview: {} };
      return { ok: true, jobs: [] };
    });
    render(<CareerResume embedded />);
    expect(await screen.findByTestId('resume-workbench')).toBeInTheDocument();
    expect(apiGetJson).toHaveBeenCalledWith('/api/career/resumes/rm_1/studio');
  });
});
