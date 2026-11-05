/**
 * 邮件发不发要不要他先看（第三轮 R2，改不变量 1）：默认每封过目；他放权之后，写好且不差东西的**投递邮件**直接发出。
 * 放权只有两种来源，都是他自己的动作，AI 不自己升（没有「连续几次没改就自动放」的路径）：
 *  1. 「自动投递」总开关（kv apply:auto_mode，网申和邮件共用）；
 *  2. 信任账本里「邮件投递」这一类他盖了章（MAIL_TRUST_KEY；和一种网申系统并列）。
 * 跟进、回信、退信重发、目标岗位、带他专门要求的，永远先给他看。形状照 decideSubmit。
 */
import type { ActionQueueItem, Repos } from '@career/core';

import { MAIL_TRUST_KEY, MAIL_TRUST_LABEL } from '../../../shared/careerMailApply';
import { getAutoMode, type SubmitDecision } from '../submit-policy';
import { isTargetApplication } from '../targets';
import { trustOf } from '../trust-ledger';
import { parseSendMailPayload } from './payload';

export type MailSendDecision = SubmitDecision;

export function decideMailSend(repos: Repos, input: { action: Pick<ActionQueueItem, 'id' | 'payload_json'>; blockers: readonly string[]; applicationId: string | null }): MailSendDecision {
  if (input.blockers.length) return { approve: false, reason: `还差东西（${input.blockers.join('、')}），先给你看` };
  const p = parseSendMailPayload(input.action.id, input.action.payload_json);
  if ((p.purpose ?? 'apply') !== 'apply') return { approve: false, reason: '跟进和回信每封都先给你看' };
  if (p.bounced_from) return { approve: false, reason: '退信后重发：先给你看收件人' };
  if (isTargetApplication(repos, input.applicationId)) return { approve: false, reason: '目标岗位：发之前先给你看' };
  if (p.has_notes) return { approve: false, reason: '这封带着你的专门要求：先给你看一眼' };
  if (getAutoMode(repos).enabled) return { approve: true, by: 'auto', reason: '自动投递开着：写好且不差东西，直接发出' };
  if (trustOf(repos, MAIL_TRUST_KEY) === 'delegated') return { approve: true, by: 'delegated', reason: `${MAIL_TRUST_LABEL}这一类你说过以后直接发` };
  return { approve: false, reason: `${MAIL_TRUST_LABEL}这一类你还没交给我，发前先给你看` };
}

/** 现在写好的投递邮件会不会直接发出（给工具回复里的一句话用；不看单封的条件）。 */
export const mailAutoSendOn = (repos: Repos): boolean => getAutoMode(repos).enabled || trustOf(repos, MAIL_TRUST_KEY) === 'delegated';
