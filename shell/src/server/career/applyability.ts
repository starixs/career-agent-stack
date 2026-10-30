/**
 * 岗位打开后填表引擎看到了什么——给工程排查用，不给用户看。
 *
 * 前提（用户 2026-10-30）：岗位库里能找到的岗位就一定能投；投不了是我们的工程问题（引擎没进到表单、
 * 岗位库数据粒度不对），不转嫁给用户——不在框选时跳过、不在岗位表上标「合集，先选具体岗位」。
 *
 * 每次填表结果记在岗位上（form / no_form / entry / login），没找到表单的打一条稳定日志锚点
 * `[career] applyability NO_FORM`，实例测试和日志里据此列出要修的岗位与网站。
 */
import type { ActionQueueItem, Repos } from '@career/core';

import { siteOf } from './app-pages';

export type Applyability = 'form' | 'no_form' | 'entry' | 'login' | 'unknown';
export interface ApplyabilityRecord { kind: Exclude<Applyability, 'unknown'>; site: string | null; at: string }

const jobKey = (jobId: string) => `apply:applyability:${jobId}`;
/** 引擎「这里没有表单」的几种说法（drive.ts finish('blocked', …)）。 */
const NO_FORM = /没有可填写的(网申)?表单|没有找到可填写的网申表单/;
const ENTRY = /^这是岗位详情页/;
const LOGIN_REASONS = new Set(['login', '2fa']);

/** 从一次填表结果判断；判断不了（失败、验证码、弹窗）返回 null，不改原来的记录。 */
export function applyabilityFromResult(result: Record<string, unknown>): ApplyabilityRecord['kind'] | null {
  const status = String(result.status ?? '');
  const message = typeof result.message === 'string' ? result.message : '';
  if (status === 'stopped_before_submit') return 'form';
  if (status === 'blocked' && NO_FORM.test(message)) return 'no_form';
  if (status === 'handoff' && ENTRY.test(message)) return 'entry';
  if (status === 'handoff' && LOGIN_REASONS.has(String(result.reason ?? ''))) return 'login';
  if (status === 'handoff' && result.reason === 'missing_info') return 'form';
  return null;
}

export function recordApplyability(repos: Repos, action: Pick<ActionQueueItem, 'payload_json'>, result: Record<string, unknown>, now = new Date()): void {
  const kind = applyabilityFromResult(result);
  if (!kind) return;
  let payload: { job_id?: unknown; url?: unknown };
  try { payload = JSON.parse(action.payload_json) as typeof payload; } catch (error) {
    console.warn('[career] applyability: payload 解析失败，不记', error instanceof Error ? error.message : error);
    return;
  }
  const url = typeof payload.url === 'string' ? payload.url : '';
  const site = url ? siteOf(url) : null;
  if (kind === 'no_form') console.warn(`[career] applyability NO_FORM job=${String(payload.job_id ?? '?')} site=${site ?? '?'} url=${url}`);
  if (typeof payload.job_id === 'string') repos.kvSet(jobKey(payload.job_id), { kind, site, at: now.toISOString() } satisfies ApplyabilityRecord);
}

export function applyabilityOf(repos: Repos, jobId: string): Applyability {
  return repos.kvGet<ApplyabilityRecord>(jobKey(jobId))?.kind ?? 'unknown';
}
