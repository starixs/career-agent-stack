import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { rememberSessionCookies, restoreSessionCookies, SESSION_COOKIE_MAX_AGE_MS } from './session-cookies';

type Cookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Lax' | 'Strict' | 'None' };
const cookie = (domain: string, name: string, expires = -1): Cookie => ({ name, value: `${name}-v`, domain, path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' });

function fakeContext(initial: Cookie[]) {
  let jar = [...initial];
  return {
    cookies: async () => jar,
    addCookies: async (cs: Cookie[]) => { jar = [...jar, ...cs]; },
    clear: () => { jar = []; },
    jar: () => jar,
  };
}

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'session-cookies-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('网申网站的会话 Cookie 跨重启保住', () => {
  it('登上时只记这个站的会话 Cookie；重启后（浏览器里没了）在这个站填表前补回', async () => {
    const dir = tmp();
    const ctx = fakeContext([cookie('.mediatek.zhiye.com', 'sid'), cookie('.mediatek.zhiye.com', 'keep', 2_000_000_000), cookie('.other.com', 'x')]);
    expect(await rememberSessionCookies(ctx, 'zhiye.com', dir)).toBe(1);
    expect(statSync(join(dir, 'session-cookies.json')).mode & 0o777).toBe(0o600);
    ctx.clear(); // 重启：会话 Cookie 没了
    expect(await restoreSessionCookies(ctx, 'https://mediatek.zhiye.com/campus/jobs', dir)).toBe(1);
    expect(ctx.jar().map(c => c.name)).toEqual(['sid']);
    expect(await restoreSessionCookies(ctx, 'https://mediatek.zhiye.com/', dir)).toBe(0); // 已经在了不重复补
    expect(await restoreSessionCookies(ctx, 'https://xiaopeng.jobs.feishu.cn/', dir)).toBe(0); // 别的站不碰
  });

  it('记下太久的不再补（站点那头多半过期了，补回去只会误判成已登录）', async () => {
    const dir = tmp();
    const saved = new Date('2026-10-01T00:00:00Z');
    await rememberSessionCookies(fakeContext([cookie('.zhiye.com', 'sid')]), 'zhiye.com', dir, saved);
    const later = new Date(saved.getTime() + SESSION_COOKIE_MAX_AGE_MS + 1);
    expect(await restoreSessionCookies(fakeContext([]), 'https://a.zhiye.com/', dir, later)).toBe(0);
  });
});
