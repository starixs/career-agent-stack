/**
 * 存过账号密码的站：直接账号密码登录（2026-11-03 用户：「支持账号密码登录的话，这个肯定是最方便的，只用记录一次，存进去，后面都不用管」）。
 * 登录之旅里排第一；没存过、或页面上找不到账号密码表单，交给后面的邮箱 / 短信那几条路。
 * 密码登录也弹图形码（中国中车）：照样把图给他看，他打的字填回去再点登录。
 */
import type { Page } from 'playwright';

import type { SmsState } from './login-journey';
import { hostOf, passImageCode, type ImageAnswerOutcome } from './login-register';
import { loadApplyModule } from '../routes/career-browser';

/** 点了登录后等网站换一张图（打错了）或者关掉登录框。 */
const AFTER_LOGIN_CLICK_MS = 1_500;

async function savedAccount(host: string): Promise<{ username: string; password: string } | null> {
  const { getVault } = await import('./vault');
  const cred = (await getVault()).credential(host, { actor: 'login_fill', purpose: '账号密码登录' });
  return cred?.username && cred.password ? { username: cred.username, password: cred.password } : null;
}

/** 返回 null：这家没存账号或找不到账号密码表单，交给后面几条路。 */
export async function loginWithSavedPassword(page: Page, report: (s: SmsState) => void): Promise<SmsState | null> {
  const host = hostOf(page.url());
  const apply = await loadApplyModule();
  if (!host || !apply?.preparePasswordLogin || !apply.submitPasswordLogin) return null;
  const account = await savedAccount(host);
  if (!account) return null;
  const P = apply.fromPlaywright(page);
  const r = await apply.preparePasswordLogin(P, account);
  if (r.status === 'no_form') { console.log(`[career] login-password ${host}: ${r.reason}`); return null; }
  if (r.status === 'captcha') return { status: 'captcha', detail: r.evidence };
  if (r.status === 'image_code') {
    const answer = async (text: string): Promise<ImageAnswerOutcome> => {
      const s = await apply.submitPasswordLogin!(P, text);
      if (s.status === 'captcha') return { status: 'captcha', detail: s.evidence };
      if (s.status !== 'submitted') return { status: 'no_sms', detail: s.status === 'no_form' ? s.reason : '图形码没填上' };
      await new Promise<void>(res => setTimeout(res, AFTER_LOGIN_CLICK_MS));
      return (await apply.imageCodeDataUrl?.(P)) ? 'again' : 'ok';
    };
    const stuck = await passImageCode(apply, page, report, answer);
    if (stuck) return stuck;
  }
  console.log(`[career] login-password ${host}: 用存的账号密码登录`);
  return { status: 'registered', detail: '账号密码填好了，正在确认登上没有…' };
}
