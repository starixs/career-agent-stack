import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RECIPES, cancelMailConnect, findAddress, findAuthCodes, getMailConnect, provideConnectAddress, resetMailConnects, startMailConnect,
  type ConnectDeps, type ConnectPage,
} from './connect';

afterEach(() => resetMailConnects());

/** 假页面：按「第几次读页面」切换网址和文字，记下点过的按钮。 */
function fakePage(script: Array<{ url: string; text: string }>): ConnectPage & { clicks: string[]; visits: string[] } {
  let i = 0;
  let last = script[0];
  const clicks: string[] = [];
  const visits: string[] = [];
  const current = () => script[Math.min(i, script.length - 1)];
  return {
    clicks, visits,
    url: () => last.url,
    goto: async url => { visits.push(url); },
    text: async () => { last = current(); i++; return last.text; },
    clickText: async text => { if (last.text.includes(text)) { clicks.push(text); return true; } return false; },
  };
}

async function settle(id: string, until: (s: NonNullable<ReturnType<typeof getMailConnect>>) => boolean) {
  for (let n = 0; n < 200; n++) {
    const s = getMailConnect(id)!;
    if (until(s)) return s;
    await new Promise(r => setTimeout(r, 0));
  }
  return getMailConnect(id)!;
}

function deps(page: ConnectPage, over: Partial<ConnectDeps> = {}): ConnectDeps {
  return {
    withPage: fn => fn(page),
    verifyLogin: async () => {},
    bind: async () => ({ account_id: 'acc1', summary: '拉到 3 封，其中 1 封与求职相关' }),
    sleep: () => new Promise(r => setTimeout(r, 0)),
    ...over,
  };
}

describe('授权码与地址识别', () => {
  it('只认关键词附近的 16 位授权码；Gmail 的四段式去掉空格', () => {
    expect(findAuthCodes('授权码\nabcdefghijklmnop\n复制', RECIPES.qq)).toEqual(['abcdefghijklmnop']);
    expect(findAuthCodes('abcdefghijklmnop 和授权无关', RECIPES.qq)).toEqual([]);
    expect(findAuthCodes('新增授权密码成功：ABCDEFGHIJKLMNOP', RECIPES['163'])).toEqual(['ABCDEFGHIJKLMNOP']);
    expect(findAuthCodes('Your app password for your device\nabcd efgh ijkl mnop', RECIPES.gmail)).toEqual(['abcdefghijklmnop']);
  });
  it('地址取页面上出现最多的那个', () => {
    expect(findAddress('me@qq.com 写信 收件箱 me@qq.com hr@qq.com', RECIPES.qq)).toBe('me@qq.com');
    expect(findAddress('没有地址', RECIPES.qq)).toBeNull();
  });
});

describe('startMailConnect', () => {
  it('扫码登录 → 自动点到生成授权码 → 读到授权码 → 验证 → 绑定', async () => {
    const page = fakePage([
      { url: 'https://mail.qq.com/', text: '微信扫码登录' },
      { url: 'https://wx.mail.qq.com/home/index?sid=x', text: 'me@qq.com 收件箱 设置' },
      { url: 'https://wx.mail.qq.com/home/index?sid=x', text: 'me@qq.com 账号与安全 生成授权码' },
      { url: 'https://wx.mail.qq.com/home/index?sid=x', text: 'me@qq.com 授权码 abcdefghijklmnop 复制授权码' },
    ]);
    const verifyLogin = vi.fn(async () => {});
    const bind = vi.fn(async () => ({ account_id: 'acc1', summary: '拉到 3 封' }));
    const s = startMailConnect(deps(page, { verifyLogin, bind }), 'qq');
    const done = await settle(s.id, x => x.status === 'done' || x.status === 'failed');
    expect(done).toMatchObject({ status: 'done', address: 'me@qq.com', account_id: 'acc1', summary: '拉到 3 封' });
    expect(page.visits).toEqual(['https://mail.qq.com/']);
    expect(page.clicks).toContain('设置');
    expect(page.clicks).toContain('生成授权码');
    expect(verifyLogin).toHaveBeenCalledWith('qq', 'me@qq.com', 'abcdefghijklmnop');
    expect(bind).toHaveBeenCalledWith('qq', 'me@qq.com', 'abcdefghijklmnop');
  });

  it('验证失败的授权码不绑定，换一个新的再试', async () => {
    const page = fakePage([
      { url: 'https://mail.163.com/js6/main.jsp?sid=1', text: 'me@163.com 授权码 AAAAAAAAAAAAAAAA' },
      { url: 'https://mail.163.com/js6/main.jsp?sid=1', text: 'me@163.com 授权码 AAAAAAAAAAAAAAAA' },
      { url: 'https://mail.163.com/js6/main.jsp?sid=1', text: 'me@163.com 授权码 BBBBBBBBBBBBBBBB' },
    ]);
    const verifyLogin = vi.fn(async (_p: string, _a: string, code: string) => { if (code.startsWith('A')) throw new Error('LOGIN failed'); });
    const bind = vi.fn(async () => ({ account_id: 'acc2', summary: 'ok' }));
    const s = startMailConnect(deps(page, { verifyLogin, bind }), '163');
    const done = await settle(s.id, x => x.status === 'done' || x.status === 'failed');
    expect(done.status).toBe('done');
    expect(verifyLogin).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith('163', 'me@163.com', 'BBBBBBBBBBBBBBBB');
  });

  it('页面上没有地址：停在 need_address，补上地址后继续', async () => {
    const page = fakePage([{ url: 'https://wx.mail.qq.com/home/index?sid=x', text: '授权码 abcdefghijklmnop' }]);
    const bind = vi.fn(async () => ({ account_id: 'acc3', summary: 'ok' }));
    const s = startMailConnect(deps(page, { bind }), 'qq');
    expect((await settle(s.id, x => x.status === 'need_address')).status).toBe('need_address');
    provideConnectAddress(s.id, ' Me@QQ.com ');
    const done = await settle(s.id, x => x.status === 'done');
    expect(done.status).toBe('done');
    expect(bind).toHaveBeenCalledWith('qq', 'me@qq.com', 'abcdefghijklmnop');
  });

  it('取消后停止；打不开浏览器时标记失败', async () => {
    const page = fakePage([{ url: 'https://mail.qq.com/', text: '扫码登录' }]);
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const s = startMailConnect(deps(page, { sleep: () => gate }), 'qq');
    await settle(s.id, x => x.status === 'login');
    expect(cancelMailConnect(s.id)?.status).toBe('cancelled');
    release();
    await new Promise(r => setTimeout(r, 0));
    expect(getMailConnect(s.id)?.status).toBe('cancelled');

    const broken = startMailConnect(deps(page, { withPage: async () => { throw new Error('还没有个人助理会话'); } }), 'gmail');
    const failed = await settle(broken.id, x => x.status === 'failed');
    expect(failed.error).toBe('还没有个人助理会话');
  });
});
