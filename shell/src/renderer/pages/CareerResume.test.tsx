import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultResumeData } from '@career/resume-studio/schema';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('@/components/resume-workbench/StudioPreview', () => ({ StudioPreview: () => <div data-testid="preview-stub" /> }));

import { apiGetJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import { NO_RESUME_OPENER } from '@/components/career/ColdStartCards';
import { PICK_RESUME_EVENT } from '@/components/chat-input/hooks/useResumePickSend';

import CareerResume from './CareerResume';

// 简历页先是汇总（每一份的成品缩略图），点开进入编辑页；指定 id 时直接打开那一份。

describe('CareerResume', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} } as never;
  });

  it('还没有简历：给两条路（跟小芽聊聊 / 上传一份），不再指向已下线的「经历」页', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => (path.endsWith('/resumes') ? { ok: true, masters: [], tailored: [] } : { ok: true, jobs: [] }));
    const chat: unknown[] = [];
    const picks: unknown[] = [];
    const offChat = onEvent('career:chat-suggest', p => chat.push(p));
    const offPick = onEvent(PICK_RESUME_EVENT, p => picks.push(p));
    render(<CareerResume embedded />);
    expect(await screen.findByText('还没有简历')).toBeInTheDocument();
    expect(screen.queryByText(/「经历」/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '跟小芽聊聊做过的事' }));
    fireEvent.click(screen.getByRole('button', { name: '上传一份' }));
    expect(chat).toEqual([expect.objectContaining({ text: NO_RESUME_OPENER, mode: 'send' })]);
    expect(picks).toHaveLength(1);
    offChat(); offPick();
  });

  it('还没有简历：下面用一份预设主简历的缩略图把做好之后的样子摆出来（不写「示例」），点不开', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => (path.endsWith('/resumes') ? { ok: true, masters: [], tailored: [] } : { ok: true, jobs: [] }));
    render(<CareerResume embedded />);
    const sample = await screen.findByTestId('sample');
    expect(screen.queryByText(/示例/)).toBeNull();
    expect(within(sample).getByTestId('preview-stub')).toBeInTheDocument();
    expect(within(sample).queryByRole('button')).toBeNull();
    expect(apiGetJson).not.toHaveBeenCalledWith(expect.stringContaining('/studio'));
  });

  it('有简历：先看到汇总，点开进入编辑页', async () => {
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.endsWith('/resumes')) return { ok: true, masters: [{ id: 'rm_1', name: '主简历' }], tailored: [] };
      if (path.endsWith('/rm_1/studio')) return { ok: true, data: structuredClone(defaultResumeData), content_updated_at: 't', preview: {} };
      return { ok: true, jobs: [] };
    });
    render(<CareerResume embedded />);
    fireEvent.click(await screen.findByRole('button', { name: '打开简历：主简历' }));
    expect(screen.queryByTestId('sample')).toBeNull();
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
