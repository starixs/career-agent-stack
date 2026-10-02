import { describe, expect, it } from 'vitest';

import { KEYSTONE_TOOL_CALL_TIMEOUT_MS } from './tool-call-policy';

describe('KEYSTONE_TOOL_CALL_TIMEOUT_MS', () => {
  it('allows keystone-owned tools to run for five minutes', () => {
    expect(KEYSTONE_TOOL_CALL_TIMEOUT_MS).toBe(300_000);
  });
});
