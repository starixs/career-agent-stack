/**
 * 登录之旅（用户 2026-10-30 定）：一家一家带你登录，登上没有数据层（新会话凭证 + 登录接口返回）和画面两路一起看。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { BATCH_COMMAND_KEY } from './batch-runner';
import { livePin, setLivePin } from './live-pin';
import { startJourney, type JourneyBrowser, type JourneyPage } from './login-journey';
import { authCookies, knownLoggedIn, learnLoginMarks, LoginJudge, newCredentials, responseVerdict, type CookieLike, type ResponseVerdict, type ScreenSample } from './login-signal';
import { createMemoryRepos } from './test-db';

describe('登录信号（数据层）', () => {
  const ck = (domain: string, name: string, value: string, expires?: number): CookieLike => ({ domain, name, value, ...(expires ? { expires } : {}) });

  it('只认这个站（含单点登录子域名）的凭证类 Cookie，埋点类不算', () => {
    const m = authCookies([ck('.meituan.com', 'token', 'a'), ck('passport.meituan.com', 'sid', 'b'), ck('.meituan.com', '_ga', 'x'), ck('.jd.com', 'token', 'c'), ck('.meituan.com', 'lang', 'zh')], 'meituan.com');
    expect([...m.keys()].map(k => k.split('|')[1]).sort()).toEqual(['sid', 'token']);
  });

  it('新出现或换了值的凭证才算登上', () => {
    const before = new Map([['.a.com|sid', 'guest']]);
    expect(newCredentials(before, new Map([['.a.com|sid', 'guest']]))).toEqual([]);
    expect(newCredentials(before, new Map([['.a.com|sid', 'user-1'], ['.a.com|token', 't']]))).toEqual(['sid', 'token']);
  });

  it('登录接口的返回：4xx、success:false、非 0 业务码算失败；不是登录接口或不是 JSON 不当证据', () => {
    expect(responseVerdict('https://a.com/api/login', 401, null)).toBe('fail');
    expect(responseVerdict('https://a.com/passport/login', 200, '{"success":false,"msg":"密码错误"}')).toBe('fail');
    expect(responseVerdict('https://a.com/sso/auth', 200, '{"code":10023}')).toBe('fail');
    expect(responseVerdict('https://a.com/sso/auth', 200, '{"code":0,"data":{}}')).toBe('ok');
    expect(responseVerdict('https://a.com/jobs/list', 200, '{"code":500}')).toBeNull();
    expect(responseVerdict('https://a.com/login', 200, '<html>')).toBeNull();
  });

  it('学过这个站的凭证名、现在都还在且没过期：直接算已登录；没学过不猜', () => {
    const repos = createMemoryRepos();
    const now = 1_800_000_000;
    expect(knownLoggedIn(repos, [ck('.a.com', 'sid', 'x')], 'a.com', now)).toBe(false);
    learnLoginMarks(repos, 'a.com', ['sid']);
    expect(knownLoggedIn(repos, [ck('.a.com', 'sid', 'x', now + 3600)], 'a.com', now)).toBe(true);
    expect(knownLoggedIn(repos, [ck('.a.com', 'sid', 'x', now - 1)], 'a.com', now)).toBe(false);
  });
});

/** 还在登录页的画面（默认）。 */
const ON_LOGIN: ScreenSample = { loginShown: true, errorShown: false };

/** 假浏览器：每家一个页面；cookies、画面按「第几次读」由脚本决定，登录接口返回由脚本推。 */
function fakeBrowser(script: { cookies: (call: number) => CookieLike[]; responses?: Record<string, ResponseVerdict[]>; screen?: (key: string, call: number) => ScreenSample | null }) {
  let screenCall = 0;
  let call = 0;
  const focused: string[] = [];
  const pages = new Map<string, JourneyPage & { key: string }>();
  const browser: JourneyBrowser = {
    cookies: async () => script.cookies(call++),
    pageFor: key => {
      if (!pages.has(key)) {
        pages.set(key, { key, url: () => `https://${key}/apply`, onLoginResponse: cb => { for (const v of script.responses?.[key] ?? []) cb(v); return () => undefined; }, screen: async () => script.screen?.(key, screenCall++) ?? ON_LOGIN });
      }
      return pages.get(key);
    },
    focus: p => { focused.push((p as JourneyPage & { key: string }).key); },
    control: () => 'agent',
    releaseControl: () => undefined,
  };
  return { browser, focused };
}

function waitingLogin(repos: Repos, site: string) {
  const job = repos.upsertJob({ source_platform: 'campus', source_job_id: site, title: '后端', company_name: site });
  const app = repos.createApplication(job.id);
  const a = repos.enqueueAction('fill_form', { url: `https://jobs.${site}/apply/1` }, app.id, true);
  return { app, action: a, handoff: repos.openHandoff('login', { actionId: a.id }) };
}

const fast = { pollMs: 1, sleep: async () => undefined };

describe('两路合起来（LoginJudge）', () => {
  const C = (v: string) => new Map([['.a.com|sid', v]]);
  const clear: ScreenSample = { loginShown: false, errorShown: false };

  it('数据层有新凭证、画面也不见登录提示：both；只有一路成立也算登上', () => {
    const both = new LoginJudge(C('guest'));
    both.observe(C('guest'), ON_LOGIN);
    both.observe(C('guest'), clear);
    expect(both.observe(C('user'), clear)).toMatchObject({ state: 'logged_in', signal: 'both' });
    expect(new LoginJudge(C('guest')).observe(C('user'), ON_LOGIN)).toMatchObject({ state: 'logged_in', signal: 'credentials' }); // 页面角落一直留着「扫码登录」的站
    const screenOnly = new LoginJudge(C('guest'));
    expect(screenOnly.observe(C('guest'), ON_LOGIN).state).toBe('waiting');
    expect(screenOnly.observe(C('guest'), clear).state).toBe('waiting'); // 闪一下不算
    expect(screenOnly.observe(C('guest'), clear)).toMatchObject({ state: 'logged_in', signal: 'screen' }); // 凭证名认不出的站：登录框出现过又不见了
  });

  it('画面一开始就没有登录框（岗位详情页、导航栏只有登录链接）：看不到登录框不等于登上，一直等', () => {
    const j = new LoginJudge(C('guest'));
    for (let i = 0; i < 5; i++) expect(j.observe(C('guest'), clear).state).toBe('waiting');
  });

  it('任何一路说失败就继续等：画面写着密码错误、或登录接口返回失败；之后重试登上（凭证又变了）就不再否决', () => {
    expect(new LoginJudge(C('guest')).observe(C('rotated'), { loginShown: true, errorShown: true }).state).toBe('failed');
    const j = new LoginJudge(C('guest'));
    j.response('fail');
    expect(j.observe(C('rotated'), ON_LOGIN).state).toBe('failed');
    expect(j.observe(C('rotated'), ON_LOGIN).state).toBe('failed');
    expect(j.observe(C('user'), ON_LOGIN)).toMatchObject({ state: 'logged_in', signal: 'credentials' });
  });
});

describe('登录之旅', () => {
  afterEach(() => setLivePin(null));

  it('一家一家过：学过的站直接放行；登上（出现新会话凭证）就关接管、交后台接着填、记下凭证名，切下一家', async () => {
    const repos = createMemoryRepos();
    learnLoginMarks(repos, 'known.com', ['sid']);
    const a = waitingLogin(repos, 'a.com');
    const k = waitingLogin(repos, 'known.com');
    const b = waitingLogin(repos, 'b.com');
    const pins: Array<string | undefined> = [];
    // a.com：第 3 次读到新 token；b.com：一直是旧 sid，之后换了新值
    const { browser, focused } = fakeBrowser({ cookies: n => [
      { domain: '.known.com', name: 'sid', value: 'k' },
      { domain: '.a.com', name: 'token', ...(n >= 2 ? { value: 'user' } : { value: '' }) },
      { domain: '.b.com', name: 'sid', value: n >= 7 ? 'user' : 'guest' },
    ] });
    const changed = () => { pins.push(livePin()?.appKey); };
    const out = await startJourney({ repos, browser, sessionKey: 's', changed, ...fast }, a.handoff.id, [a.handoff.id, k.handoff.id, b.handoff.id]);

    expect(out?.steps.map(s => s.outcome)).toEqual(['logged_in', 'known', 'logged_in']);
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(focused).toEqual([a.app.id, b.app.id]); // 学过的站不切画面
    expect(repos.kvGet<string[]>('browser:login_marks:a.com')).toEqual(['token']);
    expect(repos.kvGet<{ ids: string[] }>(BATCH_COMMAND_KEY)?.ids.sort()).toEqual([a.action.id, k.action.id, b.action.id].sort());
    expect(pins).toContain(a.app.id);
    expect(livePin()).toBeNull(); // 走完松开
  });

  it('登录接口返回失败（密码错）时凭证变了也不算，继续等', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    let t = 0;
    const { browser } = fakeBrowser({ cookies: n => [{ domain: '.a.com', name: 'sid', value: n >= 1 ? 'rotated' : 'guest' }], responses: { [a.app.id]: ['fail'] } });
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, pollMs: 1, timeoutMs: 50, sleep: async () => { t += 10; }, now: () => t }, a.handoff.id, [a.handoff.id]);
    expect(out?.steps[0].outcome).toBe('timeout');
    expect(repos.openHandoffs()).toHaveLength(1);
  });

  it('一家等太久：停在这里，剩下的留在等你条里；你点「交还」的那一家照样放行', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const b = waitingLogin(repos, 'b.com');
    let t = 0;
    const { browser } = fakeBrowser({ cookies: () => [] });
    const sleep = async () => { t += 10; if (t === 20) repos.closeHandoff(a.handoff.id, 'live_handback'); };
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, pollMs: 1, timeoutMs: 100, sleep, now: () => t }, a.handoff.id, [a.handoff.id, b.handoff.id]);
    expect(out?.steps.map(s => s.outcome)).toEqual(['handed_back', 'timeout']);
    expect(repos.openHandoffs().map(h => h.id)).toEqual([b.handoff.id]);
  });

  it('凭证名认不出、但画面上登录提示稳定消失：也算登上（signal=screen）', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const { browser } = fakeBrowser({ cookies: () => [{ domain: '.a.com', name: 'XYZ_K', value: 'opaque' }], screen: (_k, n) => (n >= 2 ? { loginShown: false, errorShown: false } : ON_LOGIN) });
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, ...fast }, a.handoff.id, [a.handoff.id]);
    expect(out?.steps[0]).toMatchObject({ outcome: 'logged_in', signal: 'screen' });
  });

  it('同一时间只走一趟', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    let t = 0;
    const { browser } = fakeBrowser({ cookies: () => [] });
    const first = startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, pollMs: 1, timeoutMs: 30, sleep: async () => { t += 10; }, now: () => t }, a.handoff.id, [a.handoff.id]);
    expect(startJourney({ repos, browser, sessionKey: 's', changed: () => undefined }, a.handoff.id, [a.handoff.id])).toBeNull();
    await first;
  });
});
