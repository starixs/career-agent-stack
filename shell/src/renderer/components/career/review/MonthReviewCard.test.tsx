import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/career-shell/navModel', () => ({ requestNavigation: vi.fn() }));

import { requestNavigation } from '@/features/career-shell/navModel';
import { MonthReviewCard } from './MonthReviewCard';

describe('「我的求职月」卡', () => {
  it('只放本月四个数，整张卡点一下就到漏斗页', () => {
    render(<MonthReviewCard title="10 月的求职" counts={[23, 4, 2, 0]} prev={[30, 5, 1, 0]} />);
    expect(screen.getByText('23')).toBeTruthy();
    expect(screen.getByText('投出 · 上月 30')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('career-card-month_review'));
    expect(requestNavigation).toHaveBeenCalledWith({ kind: 'career-review' });
  });
});
