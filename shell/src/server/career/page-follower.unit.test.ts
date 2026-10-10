import { describe, expect, it } from 'vitest';

import { createPageFollower } from './page-follower';

const page = (name: string) => { let closed = false; const frame = { name }; return { name, isClosed: () => closed, mainFrame: () => frame, close: () => { closed = true; } }; };

describe('createPageFollower', () => {
  it('新开的标签页跟过去；它关掉后回到选中页；选中页被换掉就不再跟旧标签', async () => {
    const app = page('网申'); const login = page('扫码登录'); const other = page('另一份网申');
    let selected = app;
    const f = createPageFollower(async () => selected);
    expect((await f.pick()).name).toBe('网申');
    await f.follow(login);
    expect((await f.pick()).name).toBe('扫码登录');
    login.close();
    expect((await f.pick()).name).toBe('网申');
    const login2 = page('二次验证');
    await f.follow(login2);
    selected = other; // 引擎切到了另一份网申
    expect((await f.pick()).name).toBe('另一份网申');
  });
});
