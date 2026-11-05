import { describe, expect, it } from 'vitest';

import { CAREER_GATEWAY_DOWN_COPY, CAREER_QUOTA_COPY, gatewayDownCopy, quotaCopy } from './model-error-copy';

describe('模型出错时的话', () => {
  it('求职壳里的额度文案不提充值（风险 E#16）', () => {
    expect(quotaCopy(true)).toBe(CAREER_QUOTA_COPY);
    expect(quotaCopy(true)).not.toContain('充值');
    expect(quotaCopy(false)).toContain('充值');
  });

  it('连不上服务时如实说是我们这边，记录都在（风险 E#15）', () => {
    expect(gatewayDownCopy('TypeError: fetch failed (cause: ECONNREFUSED 127.0.0.1:443)')).toBe(CAREER_GATEWAY_DOWN_COPY);
    expect(gatewayDownCopy('API Error: 400 invalid request')).toBeNull();
  });
});
