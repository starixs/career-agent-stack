import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn() }));

import { apiPostJson } from '@/api/apiFetch';
import { composeRetro } from '../RetroChecklist';
import { NotRight, PickApplication } from './InboxFixButtons';

describe('通知中心一键修正（立场 9：点一下，不写一段话）', () => {
  beforeEach(() => { vi.mocked(apiPostJson).mockReset(); vi.mocked(apiPostJson).mockResolvedValue({ ok: true, result: {} }); });

  it('读错了：点「不对」→ 选「面试邀请」，发 correct，回报改成了什么；当前类型不在选项里', async () => {
    const done = vi.fn();
    render(<NotRight inboxId="inb1" current="rejection" onDone={done} />);
    fireEvent.click(screen.getByRole('button', { name: '不对' }));
    expect(screen.queryByRole('button', { name: '拒信' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '面试邀请' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('已改成面试邀请'));
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/inbox/inb1/correct', { kind: 'interview_invite' });
  });

  it('同一家几份在投：候选是按钮，点一下就归档', async () => {
    const done = vi.fn();
    render(<PickApplication inboxId="inb2" choices={[{ application_id: 'a1', label: '美团 · 后端' }, { application_id: 'a2', label: '美团 · 算法' }]} onDone={done} />);
    fireEvent.click(screen.getByRole('button', { name: '美团 · 算法' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('已归到 美团 · 算法'));
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/inbox/inb2/assign', { application_id: 'a2' });
  });
});

describe('复盘勾一勾', () => {
  const items = [{ key: 'p0', text: 'AUC 提升怎么归因', source: 'prediction' as const }, { key: 'q1', text: '负样本怎么采', source: 'question' as const }, { key: 'q2', text: '没问到的题', source: 'question' as const }];
  it('只写勾了的，没勾的不写（免得被当成「没被问到」去推断）', () => {
    expect(composeRetro(items, { p0: 'stuck', q1: 'asked' }, '一般', '')).toBe('被问到、答上来了：负样本怎么采。被问到、卡住了：AUC 提升怎么归因。整体感觉：一般');
    expect(composeRetro(items, {}, null, '')).toBe('');
  });
});
