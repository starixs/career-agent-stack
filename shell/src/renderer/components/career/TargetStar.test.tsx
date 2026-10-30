import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiPostJson } from '@/api/apiFetch';
import { TargetStar } from './TargetStar';

describe('TargetStar', () => {
  beforeEach(() => { vi.mocked(apiPostJson).mockReset(); vi.mocked(apiPostJson).mockResolvedValue({ ok: true }); });

  it('没标的点一下标成目标，标过的点一下取消', async () => {
    const onChanged = vi.fn();
    const { rerender } = render(<TargetStar jobId="j1" source={null} label="美团 算法" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /标成目标岗位/ }));
    await waitFor(() => expect(apiPostJson).toHaveBeenCalledWith('/api/career/targets', { job_id: 'j1', target: true }));
    expect(onChanged).toHaveBeenCalled();
    rerender(<TargetStar jobId="j1" source="user" label="美团 算法" />);
    fireEvent.click(screen.getByRole('button', { name: /取消目标/ }));
    await waitFor(() => expect(apiPostJson).toHaveBeenLastCalledWith('/api/career/targets', { job_id: 'j1', target: false }));
  });

  it('进过面试的自动算目标，不能取消', () => {
    render(<TargetStar jobId="j1" source="interview" label="百度 算法" />);
    expect(screen.getByRole('button', { name: /进过面试，自动算目标/ })).toBeDisabled();
  });
});
