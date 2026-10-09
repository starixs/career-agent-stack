/**
 * 提交介入程度（产品决策 2026-10-09）：
 *  - 默认：每份网申填完停在提交前，审阅清单给用户看一遍，用户批准后由产品点提交；
 *  - auto 模式（用户主动打开）：填后检查没有需要人看的项就直接批准提交（approved_by='auto'）；
 *  - 自学习免审：同一张表（formSignature 相同）用户连续 LEARN_THRESHOLD 次没改动直接批准且提交成功，
 *    之后这张表免人工确认（approved_by='learned'）——前提是简历版本（resume_sha256）与开放题答案
 *    （openAnswersHash）都和上一次用户批准时完全一致；有任何新内容就停下给人看。
 *
 * 任何一种免审都要求填后检查 attention === 0（必填为空 / 值没生效 / 站点报错 / 附件没回显 / 草稿 / 待补 都不行）。
 * 页面上被用户改过、提交失败、用户拒绝，都把这张表的计数清零。
 */
import type { Repos } from '@career/core';

export const AUTO_MODE_KEY = 'apply:auto_mode';
export const LEARN_THRESHOLD = 3;
const trustKey = (signature: string) => `apply:page_trust:${signature}`;

export interface AutoModeSetting { enabled: boolean; updatedAt?: string }
export interface PageTrust { streak: number; resumeSha: string | null; answersHash: string | null; host?: string; updatedAt: string }
export interface SubmitFingerprint { formSignature?: string | null; openAnswersHash?: string | null; resumeSha?: string | null; attention: number }
export type SubmitDecision = { approve: true; by: 'auto' | 'learned'; reason: string } | { approve: false; reason: string };

export function getAutoMode(repos: Repos): AutoModeSetting {
  return repos.kvGet<AutoModeSetting>(AUTO_MODE_KEY) ?? { enabled: false };
}
export function setAutoMode(repos: Repos, enabled: boolean): AutoModeSetting {
  const next = { enabled, updatedAt: new Date().toISOString() };
  repos.kvSet(AUTO_MODE_KEY, next);
  return next;
}
export function getPageTrust(repos: Repos, signature: string): PageTrust | undefined {
  return repos.kvGet<PageTrust>(trustKey(signature));
}

export function decideSubmit(repos: Repos, fp: SubmitFingerprint): SubmitDecision {
  if (fp.attention > 0) return { approve: false, reason: `填后检查有 ${fp.attention} 项需要你看` };
  if (getAutoMode(repos).enabled) return { approve: true, by: 'auto', reason: 'auto 模式：检查全部通过，直接提交' };
  if (!fp.formSignature) return { approve: false, reason: '没有界面指纹，按默认需要你确认' };
  const trust = getPageTrust(repos, fp.formSignature);
  if (!trust || trust.streak < LEARN_THRESHOLD) return { approve: false, reason: `这张表你已连续 ${trust?.streak ?? 0} 次直接通过，满 ${LEARN_THRESHOLD} 次后免确认` };
  if ((trust.resumeSha ?? null) !== (fp.resumeSha ?? null)) return { approve: false, reason: '这次用的简历和你上次批准的不是同一份，需要你确认' };
  if ((trust.answersHash ?? null) !== (fp.openAnswersHash ?? null)) return { approve: false, reason: '开放题答案和你上次批准的不一样，需要你确认' };
  return { approve: true, by: 'learned', reason: `这张表你已连续 ${trust.streak} 次直接通过，简历与开放题答案都没变，免确认提交` };
}

/** 提交执行完：按结果更新这张表的信任计数。只有用户本人批准、页面没改、提交成功才 +1。 */
export function recordSubmitOutcome(repos: Repos, input: { approvedBy: string | null; status: string; edits: number } & Omit<SubmitFingerprint, 'attention'>): PageTrust | undefined {
  if (!input.formSignature) return undefined;
  const key = trustKey(input.formSignature);
  const cur = repos.kvGet<PageTrust>(key);
  const now = new Date().toISOString();
  let next: PageTrust;
  if (input.status !== 'submitted' || input.edits > 0) next = { streak: 0, resumeSha: cur?.resumeSha ?? null, answersHash: cur?.answersHash ?? null, updatedAt: now };
  else if (input.approvedBy === 'user') next = { streak: (cur?.streak ?? 0) + 1, resumeSha: input.resumeSha ?? null, answersHash: input.openAnswersHash ?? null, updatedAt: now };
  else return cur; // auto / learned 的成功不增加"人工确认"计数
  repos.kvSet(key, next);
  return next;
}

/** 用户拒绝了这张表的提交：计数清零。 */
export function resetPageTrust(repos: Repos, signature: string | null | undefined): void {
  if (!signature) return;
  const cur = repos.kvGet<PageTrust>(trustKey(signature));
  if (cur) repos.kvSet(trustKey(signature), { ...cur, streak: 0, updatedAt: new Date().toISOString() });
}
