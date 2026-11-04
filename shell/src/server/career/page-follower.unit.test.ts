import { describe, expect, it } from 'vitest';

import { createPageFollower } from './page-follower';

const page = (name: string) => { let closed = false; const frame = { name }; return { name, isClosed: () => closed, mainFrame: () => frame, close: () => { closed = true; } }; };

describe('createPageFollower', () => {
  it('新开的标签页跟过去；它关掉后回到选中页；选中页被换掉就不再跟旧标签', async () => {
    const app = page('网申'); const login = page('扫码登录'); const other = page('另一份网申');
    let selected = app;
    const f = createPageFollower(async () => selected);
    expect((await f.pick()).name).toBe('网申');
    await f.follow(login, app);
    expect((await f.pick()).name).toBe('扫码登录');
    login.close();
    expect((await f.pick()).name).toBe('网申');
    const login2 = page('二次验证');
    await f.follow(login2, app);
    selected = other; // 引擎切到了另一份网申
    expect((await f.pick()).name).toBe('另一份网申');
  });

  it('后台别家开的新页不跟：选中中车，画面不被别家的页面抢走（2026-11-03）', async () => {
    const crrc = page('中国中车'); const other = page('别家网申'); const bg = page('别家新开的页');
    const f = createPageFollower(async () => crrc);
    expect(await f.follow(bg, other)).toBe(false);
    expect(await f.follow(page('没有 opener'), null)).toBe(false);
    expect((await f.pick()).name).toBe('中国中车');
  });
});
