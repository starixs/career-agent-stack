/**
 * 登录之旅（用户 2026-10-30 定）：一家一家带你登录，登上没有数据层（新会话凭证 + 登录接口返回）和画面两路一起看。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Repos } from '@career/core';

import { BATCH_COMMAND_KEY } from './batch-runner';
import { livePin, setLivePin } from './live-pin';
import { journeySms, skipJourneyStep, startJourney, submitJourneyCode, type JourneyBrowser, type JourneyPage } from './login-journey';
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
function fakeBrowser(script: { cookies: (call: number) => CookieLike[]; responses?: Record<string, ResponseVerdict[]>; screen?: (key: string, call: number) => ScreenSample | null; closed?: (key: string) => boolean }) {
  let screenCall = 0;
  let call = 0;
  const focused: string[] = [];
  const pages = new Map<string, JourneyPage & { key: string }>();
  const browser: JourneyBrowser = {
    cookies: async () => script.cookies(call++),
    pageFor: key => {
      if (!pages.has(key)) {
        pages.set(key, { key, url: () => `https://${key}/apply`, onLoginResponse: cb => { for (const v of script.responses?.[key] ?? []) cb(v); return () => undefined; }, screen: async () => script.screen?.(key, screenCall++) ?? ON_LOGIN, closed: () => script.closed?.(key) ?? false });
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

  it('登录表单还开着时，点「获取验证码」冒出来的 token Cookie 不算登上；登录接口返回成功、或表单关掉后才算（2026-11-02 美团）', () => {
    const form: ScreenSample = { loginShown: true, errorShown: false, formShown: true };
    const j = new LoginJudge(C('guest'));
    j.observe(C('guest'), form);
    expect(responseVerdict('https://verify.meituan.com/v2/ext_api/page_data?yoda', 200, '{"status":1}')).toBeNull(); // 滑块
    expect(responseVerdict('https://passport.meituan.com/api/sendSmsCode', 200, '{"code":0}')).toBeNull(); // 发码
    expect(j.observe(C('risk-token'), form).state).toBe('waiting');
    j.response(responseVerdict('https://passport.meituan.com/api/login/mobile', 200, '{"code":0}'));
    expect(j.observe(C('user'), form)).toMatchObject({ state: 'logged_in', signal: 'credentials' });
    // 没听到登录接口，但登录表单关了、新凭证在：照样算
    const k = new LoginJudge(C('guest'));
    k.observe(C('guest'), form);
    expect(k.observe(C('user'), ON_LOGIN)).toMatchObject({ state: 'logged_in', signal: 'credentials' });
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
    const { browser, focused } = fakeBrowser({ screen: key => (key === k.app.id ? { loginShown: false, errorShown: false } : ON_LOGIN), cookies: n => [
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

  it('学过的凭证还在、页面却还要登录：学错了，忘掉、让你真登一次（2026-11-02 美团：风控 Cookie 被记成登录凭证，之后永远轮不到你登录）', async () => {
    const repos = createMemoryRepos();
    learnLoginMarks(repos, 'a.com', ['risk_token']);
    const a = waitingLogin(repos, 'a.com');
    const { browser } = fakeBrowser({ cookies: n => [{ domain: '.a.com', name: 'risk_token', value: 'x' }, { domain: '.a.com', name: 'token', value: n >= 3 ? 'user' : '' }] });
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, ...fast }, a.handoff.id, [a.handoff.id]);
    expect(out?.steps.map(s => s.outcome)).toEqual(['logged_in']);
    expect(repos.kvGet<string[]>('browser:login_marks:a.com')).toEqual(['token']);
  });

  it('学生把页面关了：这家不干等，交给后台重新打开，接着下一家', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const b = waitingLogin(repos, 'b.com');
    const { browser } = fakeBrowser({ cookies: n => [{ domain: '.b.com', name: 'sid', value: n >= 5 ? 'user' : 'guest' }], closed: key => key === a.app.id });
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, ...fast }, a.handoff.id, [a.handoff.id, b.handoff.id]);
    expect(out?.steps.map(s => s.outcome)).toEqual(['page_closed', 'logged_in']);
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(repos.kvGet<{ ids: string[] }>(BATCH_COMMAND_KEY)?.ids).toContain(a.action.id); // a 交给后台重开
  });

  it('画面上已经登上了（看得见「退出」、没有登录表单）：直接放行、交后台接着填，不找登录框不干等（2026-11-03 中国中车）', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    let prepared = false;
    const { browser } = fakeBrowser({ cookies: () => [], screen: () => ({ loginShown: false, errorShown: false, loggedIn: true }) });
    const pageFor = browser.pageFor;
    browser.pageFor = key => { const p = pageFor(key); return p && { ...p, smsPrepare: async () => { prepared = true; return { status: 'no_sms' as const }; } }; };
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, ...fast }, a.handoff.id, [a.handoff.id]);
    expect(out?.steps.map(s => s.outcome)).toEqual(['known']);
    expect(prepared).toBe(false);
    expect(repos.openHandoffs()).toHaveLength(0);
    expect(repos.kvGet<{ ids: string[] }>(BATCH_COMMAND_KEY)?.ids).toContain(a.action.id);
  });

  it('登录框出现过，登上后藏起来、右上角出现「退出」：算登上（signal=screen）', () => {
    const j = new LoginJudge(new Map());
    expect(j.observe(new Map(), { loginShown: true, errorShown: false, formShown: true }).state).toBe('waiting');
    expect(j.observe(new Map(), { loginShown: false, errorShown: false, loggedIn: true })).toMatchObject({ state: 'logged_in', signal: 'screen' });
  });

  it('准备阶段（等图形码 / 拼图后的邮件）点「这家先跳过」：马上换下一家，不等准备做完（2026-11-05）', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const b = waitingLogin(repos, 'b.com');
    const { browser } = fakeBrowser({ cookies: n => [{ domain: '.b.com', name: 'sid', value: n >= 3 ? 'user' : 'guest' }] });
    const pageFor = browser.pageFor;
    let hang: (() => void) | undefined;
    browser.pageFor = key => { const p = pageFor(key); return p && key === a.app.id ? { ...p, smsPrepare: () => new Promise(r => { hang = () => r({ status: 'no_sms' as const }); }) } : p; };
    const run = startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, pollMs: 1, sleep: () => new Promise(r => setTimeout(r, 1)) }, a.handoff.id, [a.handoff.id, b.handoff.id]);
    await new Promise(r => setTimeout(r, 10));
    skipJourneyStep();
    const out = await run;
    expect(out?.steps.map(s => s.outcome)).toEqual(['skipped', 'logged_in']);
    hang?.(); // 被丢下的准备工作后来才做完：不影响结果
  });

  it('App 重启过、页面都没了：直接打开这一家的网址，就在这一家登录，不交后台整批重开（2026-11-03）', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const { browser } = fakeBrowser({ cookies: n => [{ domain: '.a.com', name: 'sid', value: n >= 3 ? 'user' : 'guest' }] });
    const opened: string[] = [];
    const pageFor = browser.pageFor;
    browser.pageFor = () => undefined;
    browser.openPage = async (key, url) => { opened.push(url); return pageFor(key); };
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, ...fast }, a.handoff.id, [a.handoff.id]);
    expect(opened).toEqual(['https://jobs.a.com/apply/1']);
    expect(out?.steps.map(s => s.outcome)).toEqual(['logged_in']);
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

  it('「这家先跳过」：这一家留在等你里，接着带你过下一家（2026-11-02 腾讯校招只能 QQ / 微信登录）', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const b = waitingLogin(repos, 'b.com');
    const { browser } = fakeBrowser({ cookies: n => [{ domain: '.b.com', name: 'token', value: n >= 6 ? 'user' : '' }] });
    let polls = 0;
    const sleep = async () => { if (++polls === 2) skipJourneyStep(); };
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, pollMs: 1, sleep }, a.handoff.id, [a.handoff.id, b.handoff.id]);
    expect(out?.steps.map(s => s.outcome)).toEqual(['skipped', 'logged_in']);
    expect(repos.openHandoffs().map(h => h.id)).toEqual([a.handoff.id]);
  });

  it('短信码代办：切到这一家先替他发码，他报的码填进这一家，登上了清掉（2026-11-03 他只管收验证码）', async () => {
    const repos = createMemoryRepos();
    const a = waitingLogin(repos, 'a.com');
    const submitted: string[] = [];
    let loggedIn = false;
    const { browser } = fakeBrowser({ cookies: () => [{ domain: '.a.com', name: 'token', value: loggedIn ? 'user' : '' }] });
    const pageFor = browser.pageFor;
    browser.pageFor = key => { const p = pageFor(key); return p && { ...p, smsPrepare: async () => ({ status: 'sent' as const }), smsSubmit: async (code: string) => { submitted.push(code); loggedIn = true; return { ok: true }; } }; };
    let seen: unknown = null;
    const sleep = async () => { if (!seen) { seen = journeySms(); expect(await submitJourneyCode('123456')).toEqual({ ok: true }); } };
    const out = await startJourney({ repos, browser, sessionKey: 's', changed: () => undefined, pollMs: 1, sleep }, a.handoff.id, [a.handoff.id]);
    // 每一步都说是哪一家；填上码先显示「正在确认」，登上了显示「已登录」留一会儿（2026-11-03 反馈感）
    expect(seen).toEqual({ status: 'sent', site: 'a.com' });
    expect(submitted).toEqual(['123456']);
    expect(out?.steps.map(s => s.outcome)).toEqual(['logged_in']);
    expect(journeySms()).toEqual({ status: 'logged_in', site: 'a.com' });
    expect(await submitJourneyCode('123456')).toMatchObject({ ok: false });
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
