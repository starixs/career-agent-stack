/**
 * 提交介入程度（产品决策 2026-10-09）：
 *  - 默认：每份网申填完停在提交前，审阅清单给用户看一遍，用户批准后由产品点提交；
 *  - auto 模式（用户主动打开）：填后检查没有需要人看的项就直接批准提交（approved_by='auto'）；
 *  - 他盖章放权（主线体验，2026-11-02 定，替代原来的「自学习免审」）：信任按「类」攒，一类 = 一种网申系统
 *    （北森、Moka…；认不出的按网站）。同类做通够数后小芽提议「以后同类直接投」，他点了，这一类才免人工确认
 *    （approved_by='delegated'）。AI 不自己升：连续批准几次不再自动免审。
 *
 * 目标岗位（进过面试、或用户亲手标的，含批次卡上的「这家我要看」）一律投前过目，auto 和自学习都不免（规范
 * CAREER_INTELLIGENT_UI.md §5.4，2026-10-27 确认）。
 *
 * 任何一种免审都要求填后检查 attention === 0（必填为空 / 值没生效 / 站点报错 / 附件没回显 / 草稿 / 待补 都不行）。
 * 页面上被用户改过、提交失败、用户拒绝，都把这张表的计数清零。
 */
import { normalizeHost, type Repos } from '@career/core';

import { isTargetApplication } from './targets';
import { systemOfSync, trustOf } from './trust-ledger';

export const AUTO_MODE_KEY = 'apply:auto_mode';
export const LEARN_THRESHOLD = 3;
const trustKey = (signature: string) => `apply:page_trust:${signature}`;

export interface AutoModeSetting { enabled: boolean; updatedAt?: string }
/**
 * 一张表的信任记录。host 和 applicationIds 是给人看的出处：「为什么这家没让我审」「我撤回哪个站」都靠它们回答
 * （formSignature 是哈希，看不出是哪个网站）。applicationIds = 本轮连续人工直接通过的那几份投递，清零时一起清。
 */
export interface PageTrust { streak: number; resumeSha: string | null; answersHash: string | null; host?: string; applicationIds?: string[]; updatedAt: string }
export interface SubmitFingerprint { formSignature?: string | null; openAnswersHash?: string | null; resumeSha?: string | null; attention: number; /** 这份投递；是目标岗位时一律给人看 */ applicationId?: string | null; /** 网申页面网址：按它认是哪一类网申系统 */ url?: string | null }
export type SubmitDecision = { approve: true; by: 'auto' | 'delegated'; reason: string } | { approve: false; reason: string };

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
  if (isTargetApplication(repos, fp.applicationId)) return { approve: false, reason: '目标岗位：投之前先给你看' };
  if (getAutoMode(repos).enabled) return { approve: true, by: 'auto', reason: 'auto 模式：检查全部通过，直接提交' };
  const system = fp.url ? systemOfSync(fp.url) : null;
  if (!system) return { approve: false, reason: '认不出是哪种网申系统，按默认需要你确认' };
  if (trustOf(repos, system.key) !== 'delegated') return { approve: false, reason: `${system.label}这一类你还没交给我，提交前先给你看` };
  return { approve: true, by: 'delegated', reason: `${system.label}这一类你说过以后直接投，检查全部通过，直接提交` };
}

/** 提交执行完：按结果更新这张表的信任计数。只有用户本人批准、页面没改、提交成功才 +1。 */
export function recordSubmitOutcome(repos: Repos, input: { approvedBy: string | null; status: string; edits: number; url?: string | null; applicationId?: string | null } & Omit<SubmitFingerprint, 'attention'>): PageTrust | undefined {
  if (!input.formSignature) return undefined;
  const key = trustKey(input.formSignature);
  const cur = repos.kvGet<PageTrust>(key);
  const now = new Date().toISOString();
  const host = input.url ? normalizeHost(input.url) : cur?.host;
  let next: PageTrust;
  if (input.status !== 'submitted' || input.edits > 0) next = { streak: 0, resumeSha: cur?.resumeSha ?? null, answersHash: cur?.answersHash ?? null, host, applicationIds: [], updatedAt: now };
  else if (input.approvedBy === 'user') {
    const applicationIds = [...(cur?.applicationIds ?? []), ...(input.applicationId ? [input.applicationId] : [])];
    next = { streak: (cur?.streak ?? 0) + 1, resumeSha: input.resumeSha ?? null, answersHash: input.openAnswersHash ?? null, host, applicationIds, updatedAt: now };
  } else return cur; // auto / learned 的成功不增加"人工确认"计数
  repos.kvSet(key, next);
  return next;
}

/** 用户拒绝了这张表的提交：计数清零。 */
export function resetPageTrust(repos: Repos, signature: string | null | undefined): void {
  if (!signature) return;
  const cur = repos.kvGet<PageTrust>(trustKey(signature));
  if (cur) repos.kvSet(trustKey(signature), { ...cur, streak: 0, applicationIds: [], updatedAt: new Date().toISOString() });
}
