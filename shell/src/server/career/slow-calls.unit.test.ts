import { describe, expect, it } from 'vitest';

import { logSlowCalls } from './slow-calls';

describe('logSlowCalls', () => {
  it('只记超过阈值的异步调用，返回值和异常照旧', async () => {
    const lines: string[] = [];
    const page = { fast: async () => 1, slow: () => new Promise(r => setTimeout(() => r(2), 30)), boom: async () => { throw new Error('x'); }, url: () => 'u' };
    const p = logSlowCalls(page, 'test', 20, l => lines.push(l));
    expect(await p.fast()).toBe(1);
    expect(await p.slow()).toBe(2);
    await expect(p.boom()).rejects.toThrow('x');
    expect(p.url()).toBe('u');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/slow-call test slow \d+ms/);
  });
});
