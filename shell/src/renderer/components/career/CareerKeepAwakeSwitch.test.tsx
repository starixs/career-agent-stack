import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(async () => ({ ok: true, enabled: true })), apiPostJson: vi.fn(async () => ({ ok: true })) }));
import { apiPostJson } from '@/api/apiFetch';

import { CareerKeepAwakeSwitch } from './CareerKeepAwakeSwitch';

describe('CareerKeepAwakeSwitch（2026-11-05 投递时保持屏幕常亮，设置里可关）', () => {
  it('缺省开着；点一下关掉', async () => {
    render(<CareerKeepAwakeSwitch />);
    const sw = screen.getByRole('switch', { name: '投递时保持屏幕常亮' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(sw);
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/batch/keep-awake', { enabled: false }));
  });
});
