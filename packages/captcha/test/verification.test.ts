import { describe, expect, it, vi } from 'vitest';

import { waitForVerification } from '../src/verification.js';

describe('验证结果轮询', () => {
  it('页面一旦通过就立即停止等待', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const ok = await waitForVerification(async () => ++calls === 3, sleep, 1000, 150);
    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('始终不通过时有界超时', async () => {
    const ok = await waitForVerification(async () => false, async () => {}, 20, 5);
    expect(ok).toBe(false);
  });
});
