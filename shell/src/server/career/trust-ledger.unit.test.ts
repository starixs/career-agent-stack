import { describe, expect, it } from 'vitest';

import { systemOfSync } from './trust-ledger';

describe('systemOfSync：按网站记的那一类，给学生看认得的名字', () => {
  it('问卷星记成「问卷星」，不是 wjx.cn；认不出的网站照旧用域名（2026-11-02 右栏「学会了」）', () => {
    expect(systemOfSync('https://v.wjx.cn/vm/rxeFdAj.aspx')).toEqual({ key: 'site:wjx.cn', label: '问卷星' });
    expect(systemOfSync('https://wj.qq.com/s2/26996638/8308/').label).toBe('腾讯');
    expect(systemOfSync('https://careers.example-unknown.com/apply').label).toBe('example-unknown.com');
  });
});
