/**
 * 登录之旅里收码走配置过的来源（2026-11-04 合入 main 后：收码以 main 的 verification-source 为准）：
 * 这家在 verification.json 里有模板（精确的发件人 / 短信签名），就在点「获取验证码」之前打开那条通道、冻结基线，
 * 码到了直接用——短信从配对手机读，邮箱按模板发件人读。没有模板返回 null，调用方用通用取码或请他填。
 */
import type { Repos } from '@career/core';

import { loadVerificationConfig, templateFor } from './verification-config';
import { prepareCodeSource, type PreparedCode } from './verification-source';

export interface LoginCodeSource { wait(since: number, timeoutMs: number): Promise<string | null>; close(): Promise<void> }

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
