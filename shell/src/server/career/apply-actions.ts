/**
 * 一份投递的在办动作（face-mail-apply 2026-11-05）：网申和邮件投递同构——
 *   网申：fill_form（后台填表）→ submit（投前过目）；
 *   邮件：draft_mail（后台写邮件）→ send_mail（发前过目）。
 * 批次卡、右栏、今天这批的数、「已在投」去重都按这里的判断数，不各处写 `kind === 'fill_form'`。
 */
import { mailPurposeOf, type ActionKind, type ActionQueueItem } from '@career/core';

type ActionLike = Pick<ActionQueueItem, 'kind' | 'status' | 'payload_json'>;

/** 投递上挂着这些状态的动作，就算「已在投」（不分种类：填表、提交、写邮件、发邮件都算）。 */
export const ACTIVE_ACTION_STATUSES: ReadonlySet<string> = new Set(['pending_review', 'approved', 'executing', 'needs_user']);

/** 「开始投」的那一步：网申填表 / 写投递邮件。批准即开始，都不会把东西交出去。 */
export const START_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>(['fill_form', 'draft_mail']);

export const isStartAction = (a: Pick<ActionQueueItem, 'kind'>): boolean => START_KINDS.has(a.kind);

/** 在做：已批准还没轮到的、正在填 / 正在写的。 */
export const isWorkingAction = (a: Pick<ActionQueueItem, 'kind' | 'status'>): boolean =>
  isStartAction(a) && (a.status === 'approved' || a.status === 'executing');

/** 后台正在写（或排着要写）的投递邮件。 */
export const isDraftingMail = (a: Pick<ActionQueueItem, 'kind' | 'status'>): boolean => a.kind === 'draft_mail' && isWorkingAction(a);

/** 写好待发、等他过目的投递邮件（跟进 / 回信不算投递）。 */
export const isHeldMail = (a: ActionLike): boolean => a.kind === 'send_mail' && a.status === 'pending_review' && mailPurposeOf(a) === 'apply';

/** 等他点头：填好停在提交前的网申、写好待发的投递邮件。 */
export const isHeldAction = (a: ActionLike): boolean => (a.kind === 'submit' && a.status === 'pending_review') || isHeldMail(a);
