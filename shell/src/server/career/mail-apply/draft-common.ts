/**
 * 后台写邮件的共用件（投递邮件 drafter.ts、跟进 / 回信 follow-drafter.ts 都用）：依赖形状、调模型带重试、
 * 失败落库、写好后排 send_mail（幂等：同一个 draft_mail 只排一封）。永远不发信。
 */
import type { ActionQueueItem, Vault } from '@career/core';

import type { PreparePacketDeps } from '../packet-prepare';
import { withTimeout } from '../tailor-for-job';
import type { SendMailPayload } from './payload';

export type AskSkill = <T>(skill: string, user: string, opts?: { refs?: string[]; temperature?: number }) => Promise<T>;

export interface DrafterDeps extends PreparePacketDeps {
  vault: Vault | null;
  askSkill: AskSkill;
  /** 一次起草最多等多久（测试注入）；缺省 MAIL_DRAFT_TIMEOUT_MS。 */
  draftTimeoutMs?: number;
  /**
   * 放权后直接发出一封已批准的 send_mail（Global 里接 executeSendMailAction；测试注入假发送）。
   * 没给就从不直接发：写好一律留在待审。
   */
  sendNow?: (actionId: string) => Promise<unknown>;
}

/** 一次起草最多等多久：写两段正文 DeepSeek 通常 10–20 秒，给足余量；超了算一次失败。 */
export const MAIL_DRAFT_TIMEOUT_MS = 60_000;
/** 模型调用最多几次（第一次 + 重试一次）。 */
const MAIL_DRAFT_ATTEMPTS = 2;

export type DraftOutcome = 'drafted' | 'failed' | 'skipped';

export function failDraft(deps: Pick<DrafterDeps, 'repos'>, action: Pick<ActionQueueItem, 'id' | 'application_id'>, reason: string, detail?: string): DraftOutcome {
  deps.repos.setActionStatus(action.id, 'failed', { error: reason });
  console.warn(`[career] mail-apply draft FAILED action=${action.id} app=${action.application_id ?? '-'} reason=${reason}${detail ? ` detail=${detail.slice(0, 200)}` : ''}`);
  return 'failed';
}

/**
 * 调技能写一次；超时 / 出错 / 解析不出要的东西重试一次，仍不成抛最后一次的错。
 * parse 返回 null = 模型没给要的东西（如正文为空），算一次失败。回信 / 跟进也走这里（换技能与解析）。
 */
export async function askWithRetry<T>(deps: Pick<DrafterDeps, 'askSkill' | 'draftTimeoutMs'>, skill: string, prompt: string, parse: (raw: unknown) => T | null): Promise<T> {
  let last: unknown;
  for (let i = 0; i < MAIL_DRAFT_ATTEMPTS; i++) {
    try {
      const raw = await withTimeout(deps.askSkill<unknown>(skill, prompt, { temperature: 0.3 }), deps.draftTimeoutMs ?? MAIL_DRAFT_TIMEOUT_MS, () => new Error('写邮件超时'));
      const out = parse(raw);
      if (out !== null) return out;
      last = new Error('模型没给正文');
    } catch (error) {
      last = error;
    }
    console.warn(`[career] mail-apply write skill=${skill} attempt=${i + 1} FAILED detail=${last instanceof Error ? last.message.slice(0, 200) : String(last)}`);
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** 这个 draft_mail 已经排出过的那封 send_mail（没作废的）；没有返回 undefined。 */
export function existingSendOf(repos: DrafterDeps['repos'], draftId: string): ActionQueueItem | undefined {
  return repos.db.get<ActionQueueItem>(
    `SELECT * FROM action_queue WHERE kind='send_mail' AND status!='rejected' AND json_extract(payload_json, '$.draft_action_id')=? ORDER BY created_at LIMIT 1`, [draftId]);
}

/**
 * 写好了：排一封 send_mail（pending_review），draft_mail 置 done（result 记 send_action_id）。
 * 幂等（S3）：上次排完 send_mail、还没来得及置 done 进程就没了，重跑时认那一封，不排第二封。
 */
export function finishDraft(repos: DrafterDeps['repos'], action: Pick<ActionQueueItem, 'id'>, payload: SendMailPayload, applicationId: string): ActionQueueItem {
  const send = existingSendOf(repos, action.id) ?? repos.enqueueAction('send_mail', { ...payload, draft_action_id: action.id }, applicationId);
  repos.setActionStatus(action.id, 'done', { send_action_id: send.id });
  return send;
}
