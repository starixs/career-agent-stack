import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { onEvent } from '@/api/eventBus';

import { InterviewPrepCard } from './InterviewPrepCard';
import type { CareerCard } from './types';

type Suggest = { text?: string; context?: { surface?: string; refs?: Record<string, string | null | undefined> } };

const card: CareerCard = {
  id: 'c1',
  kind: 'interview_prep',
  title: '准备甲公司的面试',
  createdAt: '2026-11-05T00:00:00.000Z',
  data: { company: '甲公司', round: 'first', job_id: 'job_9', at: null },
};

describe('InterviewPrepCard', () => {
  it('starts the mock interview with plain words; job id and round go through hidden context', () => {
    const sent: Suggest[] = [];
    const off = onEvent<Suggest>('career:chat-suggest', payload => { sent.push(payload); });
    render(<InterviewPrepCard card={card} onDone={vi.fn()} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始模拟' }));
    off();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('开始模拟甲公司');
    expect(sent[0].text).not.toMatch(/job_id|round=|job_9/);
    expect(sent[0].context).toEqual({ surface: 'interview', refs: { job_id: 'job_9', round: 'first' } });
  });
});
