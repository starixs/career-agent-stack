import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));

import { apiGetJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';
import CareerGuide from './CareerGuide';

const checklist = { has_experience: true, has_confirmed_claim: false, has_master_resume: false, has_mail_account: false, has_job: false, has_application: false, has_material: false };

describe('CareerGuide', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset();
    vi.mocked(apiGetJson).mockImplementation(async (path: string) => {
      if (path.startsWith('/api/career/onboarding')) return { ok: true, checklist };
      return { ok: true };
    });
  });

  it('渲染三条回路、复盘、怎么开始与永不替做清单', async () => {
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    for (const title of ['投递回路', '面试回路', '素材回路', '复盘', '怎么开始', '助理永远不会替你做的事']) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getByText('丢 JD 进收件箱，评估值不值得投')).toBeInTheDocument();
    expect(screen.getByText('面试前一键摊开卷宗')).toBeInTheDocument();
    expect(screen.getByText('开放题答案库与一致性')).toBeInTheDocument();
    expect(screen.getByText('最终提交与发送')).toBeInTheDocument();
    // onboarding 标出已用过的能力
    expect(await screen.findByText('已用过')).toBeInTheDocument();
  });

  it('能力卡按钮真的发进对话，带 surface=guide；开始步骤发 career:focus', async () => {
    render(<CareerGuide isActive onOpenChat={vi.fn()} />);
    const seen: Array<{ text: string; context?: { surface?: string } }> = [];
    const off = onEvent<{ text: string; context?: { surface?: string } }>('career:chat-suggest', p => { seen.push(p); });
    fireEvent.click(screen.getByRole('button', { name: '试试：「帮我模拟一场一面」' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ text: '帮我模拟一场一面', context: { surface: 'guide' } });
    off();

    const focus: Array<{ surface: string }> = [];
    const offFocus = onEvent<{ surface: string }>('career:focus', p => { focus.push(p); });
    fireEvent.click(screen.getByRole('button', { name: '去收件箱' }));
    fireEvent.click(screen.getByRole('button', { name: '去今日' }));
    expect(focus.map(f => f.surface)).toEqual(['inbox', 'today']);
    offFocus();
  });
});
