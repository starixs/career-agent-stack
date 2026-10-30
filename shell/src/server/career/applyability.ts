/**
 * 岗位的可投性（10-30 全新实例复盘第 4、5 条：选的 8 个里 6 个没表单、2 个要登录，是投的时候一个个撞出来的）。
 *
 * 每次填表引擎打开过一个岗位，就把它看到的记在这个岗位上：
 *  - form：有能填的网申表；
 *  - no_form：页面上没有表单（多是合集 / 批次入口 / 宣传页），要先点开选具体岗位；
 *  - entry：岗位详情页，要点「申请」入口（通常还要登录）；
 *  - login：要先登录这个站。
 * 框选确认时据此跳过 no_form、列出这批要用到哪几个站、哪几个要登录；岗位表上同样标出来。
 * 没打开过的就是 unknown，不猜（立场 3）。
 */
import type { ActionQueueItem, Repos } from '@career/core';

import { siteOf } from './app-pages';

export type Applyability = 'form' | 'no_form' | 'entry' | 'login' | 'unknown';
export interface ApplyabilityRecord { kind: Exclude<Applyability, 'unknown'>; site: string | null; at: string }

const jobKey = (jobId: string) => `apply:applyability:${jobId}`;
const siteLoginKey = (site: string) => `apply:site_login:${site}`;
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
  const site = typeof payload.url === 'string' ? siteOf(payload.url) : null;
  if (typeof payload.job_id === 'string') repos.kvSet(jobKey(payload.job_id), { kind, site, at: now.toISOString() } satisfies ApplyabilityRecord);
  if (site && (kind === 'login' || kind === 'entry')) repos.kvSet(siteLoginKey(site), true);
}

export function applyabilityOf(repos: Repos, jobId: string): Applyability {
  return repos.kvGet<ApplyabilityRecord>(jobKey(jobId))?.kind ?? 'unknown';
}

/** 这个站上次投的时候要过登录（登录之旅登上以后凭证会记住，这里只说「要用账号」）。 */
export const siteUsesLogin = (repos: Repos, site: string): boolean => repos.kvGet<boolean>(siteLoginKey(site)) === true;
