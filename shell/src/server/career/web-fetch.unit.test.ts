import { describe, expect, it } from 'vitest';

import { fetchPage } from './web-fetch';

// 直取层的判定：拿得到就给正文，拿不到要说清该不该升级到浏览器（样本取自 2026-10-30 真实站点的形态）。

const respond = (body: string, init: { status?: number; type?: string; url?: string } = {}): typeof fetch => (async () => {
  const res = new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' } });
  Object.defineProperty(res, 'url', { value: init.url ?? 'https://a.com/x' });
  return res;
}) as typeof fetch;

const article = `<html><head><title>美团 2027 校招宣讲会日程</title></head><body><article>${'北京大学 10 月 31 日 19:00 百周年纪念讲堂。'.repeat(30)}</article></body></html>`;

describe('fetchPage', () => {
  it('静态文章：直接给正文，不用开浏览器', async () => {
    const p = await fetchPage('https://mp.weixin.qq.com/s/x', respond(article));
    expect(p.verdict).toBe('ok');
    expect(p.title).toBe('美团 2027 校招宣讲会日程');
    expect(p.text).toContain('百周年纪念讲堂');
  });

  it('单页应用空壳（字节、腾讯校招页直取只剩挂载点）→ needs_browser', async () => {
    const p = await fetchPage('https://jobs.bytedance.com/campus/position', respond('<html><head><title>字节跳动校园招聘</title><script src="/main.js"></script></head><body><div id="root"></div></body></html>'));
    expect(p.verdict).toBe('needs_browser');
    expect(p.note).toContain('browser_open');
  });

  it('反爬验证页（搜狗 antispider）→ blocked', async () => {
    const p = await fetchPage('https://weixin.sogou.com/weixin?q=1', respond('<html><body>此验证码用于确认这些请求是您的正常行为而不是自动程序发出的，需要您协助验证。</body></html>', { url: 'https://weixin.sogou.com/antispider/?from=x' }));
    expect(p.verdict).toBe('blocked');
  });

  it('403 / 429 → blocked；401 → login', async () => {
    expect((await fetchPage('https://a.com', respond('nope', { status: 403 }))).verdict).toBe('blocked');
    expect((await fetchPage('https://a.com', respond('slow down', { status: 429 }))).verdict).toBe('blocked');
    expect((await fetchPage('https://a.com', respond('auth', { status: 401 }))).verdict).toBe('login');
  });

  it('只有登录框的页面 → login，提示请用户帮一下再接着办', async () => {
    const p = await fetchPage('https://www.nowcoder.com/jobs/school/center', respond('<html><body>请使用微信扫码登录<input type="password"></body></html>'));
    expect(p.verdict).toBe('login');
    expect(p.note).toContain('browser_wait_user');
  });

  it('PDF 等非网页 → not_html；网络失败 → error，不抛', async () => {
    expect((await fetchPage('https://a.com/a.pdf', respond('%PDF-broken', { type: 'application/pdf' }))).verdict).toBe('not_html');
    expect((await fetchPage('https://a.com/a.png', respond('png', { type: 'image/png' }))).verdict).toBe('not_html');
    const p = await fetchPage('https://nowhere.invalid', (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch);
    expect(p.verdict).toBe('error');
    expect(p.note).toContain('ENOTFOUND');
  });
});
