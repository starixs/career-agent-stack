/**
 * 登录之旅里收码走配置过的来源（2026-11-04 合入 main 后：收码以 main 的 verification-source 为准）：
 * 这家在 verification.json 里有模板（精确的发件人 / 短信签名），就在点「获取验证码」之前打开那条通道、冻结基线，
 * 码到了直接用——短信从配对手机读，邮箱按模板发件人读。没有模板返回 null，调用方用通用取码或请他填。
 */
import type { Repos } from '@career/core';

import { loadVerificationConfig, templateFor } from './verification-config';
import { acquireCodeLease, prepareCodeSource, type PreparedCode } from './verification-source';

export interface LoginCodeSource {
  wait(since: number, timeoutMs: number): Promise<string | null>; close(): Promise<void>;
  /** 读到的码填进去了：记下这家短信的签名，下次只认它（通用收码自己学出来的「精准」）。 */
  confirm?(): void;
}

/** 通用收码学到的「这家短信签名」：kv 键。 */
export const learnedSignatureKey = (site: string) => `sms_signature:${site}`;

/** 打开这家的收码通道；没配、没开、通道不可用都返回 null（原因进日志）。 */
export async function openLoginCodeSource(repos: Repos, url: string, channel: 'sms' | 'email', recipient: string): Promise<LoginCodeSource | null> {
  let template;
  try {
    const config = await loadVerificationConfig();
    if (!config.enabled) return null;
    template = templateFor(config, url);
  } catch (e) {
    console.warn('[career] login-code-source: 读收码配置失败', e instanceof Error ? e.message : e);
    return null;
  }
  if (!template || template.channel !== channel) return null;
  const abort = new AbortController();
  let source: PreparedCode;
  try {
    source = await prepareCodeSource(repos, template, recipient, abort.signal);
  } catch (e) {
    console.warn(`[career] login-code-source ${template.id}: 收码通道没打开`, e instanceof Error ? e.message : e);
    return null;
  }
  console.log(`[career] login-code-source ${template.id}: ${channel === 'sms' ? '从手机' : '从邮箱'}自动收码`);
  return {
    // main 的邮箱等待只在取消时结束：到点就取消，当作没等到
    wait: async (since, timeoutMs) => {
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try { return await source.wait(since); } catch (e) {
        if (!abort.signal.aborted) console.warn(`[career] login-code-source ${template.id}: 等码出错`, e instanceof Error ? e.message : e);
        return null;
      } finally { clearTimeout(timer); }
    },
    close: async () => { abort.abort(); await source.close(); },
  };
}

/** 手机这条短信收码通道同一时间只给一处用（登录之旅一次一家，网申填表里也可能在等码）。 */
const PHONE_LEASE = 'sms:paired-phone';

/**
 * 没配模板时，短信验证码也从产品里连好的手机自己读（2026-11-05 用户：要手机验证码的，自动用产品内的功能收码去填）。
 * 陌生网站：只认点「获取验证码」之后到达、带验证码的第一条。登上过的网站：记下了那条短信的【签名】，只认这个签名——
 * 同一分钟里银行、外卖的验证码就串不进来；按签名等不到就忘掉它，退回通用。手机没连上返回 null，调用方再请他填。
 */
export async function openPhoneCodeSource(repos?: Repos, site?: string | null): Promise<LoginCodeSource | null> {
  const abort = new AbortController();
  try {
    const { phoneLink } = await import('./phone');
    const phone = await phoneLink();
    if (!(await phone.ensureConnected(abort.signal))) return null;
    const release = await acquireCodeLease(PHONE_LEASE, abort.signal);
    const key = site ? learnedSignatureKey(site) : null;
    const learned = key && repos ? repos.kvGet<string | null>(key) ?? null : null;
    let got: string | null = null;
    console.log(`[career] login-code-source: 从连着的手机自动收短信验证码${learned ? `（只认【${learned}】）` : ''}`);
    return {
      wait: async (since, timeoutMs) => {
        const sms = await phone.waitForCode({ since, timeoutMs, signal: abort.signal, signature: learned });
        got = sms?.signature ?? null;
        if (!sms && learned && key && repos && !abort.signal.aborted) { repos.kvSet(key, null); console.log(`[career] login-code-source ${site}: 按【${learned}】没等到，忘掉，下次用通用`); }
        return sms?.code ?? null;
      },
      confirm: () => { if (key && repos && got && got !== learned) { repos.kvSet(key, got); console.log(`[career] login-code-source ${site}: 记下短信签名【${got}】`); } },
      close: async () => { release(); abort.abort(); },
    };
  } catch (e) {
    console.warn('[career] login-code-source: 手机收码没打开', e instanceof Error ? e.message : e);
    return null;
  }
}
