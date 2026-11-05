/**
 * 建议条「备好的 3 家都投出 / 再试一次这 3 家 / 这 N 家都开始」（ask_primary）：
 * 点了就走卡组主按钮同一套落库，不只打开卡组；办掉了的、要他先填的退回打开卡组。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/apiFetch', () => ({ apiGetJson: vi.fn(), apiPostJson: vi.fn(), apiPutJson: vi.fn(), apiDelete: vi.fn() }));
vi.mock('./WaitingDock', () => ({ requestOpenDeck: vi.fn() }));

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { onEvent } from '@/api/eventBus';

import { runAskPrimary } from './askPrimary';
import type { AskView } from './deliveryApi';
import { requestOpenDeck } from './WaitingDock';

const base = { application_ids: ['a1', 'a2', 'a3'], companies: [], due_at: null, overdue: false };
const REVIEW: AskView = { ...base, id: 'rev_1', kind: 'review', title: '3 家备好了', sources: ['act_1', 'act_2', 'act_3'].map(id => ({ type: 'action' as const, id })) };
const FAILED: AskView = { ...base, id: 'fail_1', kind: 'failed', title: '3 家没填成', sources: [{ type: 'handoff', id: 'fail_1' }] };
const INFO: AskView = { ...base, id: 'hnd_1', kind: 'info', title: '证件号码', sources: [{ type: 'handoff', id: 'hnd_1' }], fields: [{ label: '证件号码', vault_field: 'idNumber', sensitive: true, fillable: true }] };

describe('ask_primary 建议条', () => {
  beforeEach(() => {
    vi.mocked(apiGetJson).mockReset().mockResolvedValue({ asks: [REVIEW, FAILED, INFO], run: null });
    vi.mocked(apiPostJson).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(requestOpenDeck).mockReset();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('备好的都投出：点了就走一键投出，不只打开卡组', async () => {
    const changed = vi.fn();
    const off = onEvent('career:data-changed', changed);
    await expect(runAskPrimary('rev_1')).resolves.toBe('resolved');
    off();
    expect(apiPostJson).toHaveBeenCalledWith(expect.stringContaining('/actions/review'), { ids: ['act_1', 'act_2', 'act_3'], decision: 'approved' });
    expect(requestOpenDeck).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('再试一次：走重试接口', async () => {
    await expect(runAskPrimary('fail_1')).resolves.toBe('resolved');
    expect(apiPostJson).toHaveBeenCalledWith('/api/career/asks/fail_1/retry', {});
    expect(requestOpenDeck).not.toHaveBeenCalled();
  });

  it('已经处理掉的那件：退回打开卡组', async () => {
    await expect(runAskPrimary('rev_gone')).resolves.toBe('deck');
    expect(requestOpenDeck).toHaveBeenCalledWith(null);
    expect(apiPostJson).not.toHaveBeenCalled();
  });

  it('info 类：打开卡组让他填', async () => {
    await expect(runAskPrimary('hnd_1')).resolves.toBe('deck');
    expect(requestOpenDeck).toHaveBeenCalledWith('hnd_1');
    expect(apiPostJson).not.toHaveBeenCalled();
  });
});
