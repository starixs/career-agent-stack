import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/pages/CareerResume', () => ({ default: () => <div data-testid="embedded-resume" /> }));

import { resetCareerSubViews, setCareerSubView } from '@/features/career-shell/subViewStore';
import CareerMaterial from './CareerMaterial';

describe('CareerMaterial', () => {
  beforeEach(() => { resetCareerSubViews(); });

  it('只剩简历：任何旧的子视图（经历 / 常用表达）都落到简历', async () => {
    for (const view of ['experience', 'library', 'memory']) {
      setCareerSubView('career-material', view);
      const { unmount } = render(<CareerMaterial isActive onOpenChat={vi.fn()} />);
      expect(await screen.findByTestId('embedded-resume')).toBeInTheDocument();
      unmount();
    }
  });
});
