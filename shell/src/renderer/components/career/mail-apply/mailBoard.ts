/**
 * 邮件投递工作台的纯逻辑（2026-11-06）：右边那一列怎么排、开始条默认勾哪几家、行上的小签和记号叫什么。
 * 一份申请走到哪由服务端裁决（MailBoardRow.station / waiting），这里只排序和取舍。
 */
import type { MailBoardRow, MailStation, MailWaitingKind } from '../../../../shared/careerMailApply';
import type { PosterState } from '../delivery/deliveryApi';
import type { Tone } from '../skills/visual';

/** 公司小签的底条（规范 §6.1）：等你 = 钢笔蓝；发出、有回音 = 墨色；在写 = 墨色短条；可以投 = 灰。 */
export const STATION_POSTER: Record<MailStation, PosterState> = {
  ready: 'wait', writing: 'run', waiting: 'ask', sent: 'done', replied: 'done',
};

/** 右边那一列：已经在投的邮件申请（可以投的在开始条里），等他过目的排最前，其余保持服务端的「最近变动在前」。 */
export function applicationRows(rows: readonly MailBoardRow[]): MailBoardRow[] {
  const live = rows.filter(r => r.station !== 'ready');
  return [...live.filter(r => r.station === 'waiting'), ...live.filter(r => r.station !== 'waiting')];
}

/** 被退回、没写成、没发出去：小签上带一个红点。 */
export const isTrouble = (row: Pick<MailBoardRow, 'waiting'>): boolean =>
  row.waiting === 'bounced' || row.waiting === 'failed_draft' || row.waiting === 'failed_send';

/** 开始条默认勾哪些：一家公司只默认勾一个岗（排在前面的那个）。 */
export function defaultReadyPicks(rows: readonly MailBoardRow[]): Set<string> {
  const seen = new Set<string>();
  const picked = new Set<string>();
  for (const row of rows) {
    const company = row.company.company_id ?? row.company.name;
    if (seen.has(company)) continue;
    seen.add(company);
    picked.add(row.key);
  }
  return picked;
}

/** 回音是哪一种：一枚章（字 + 状态色）；真人回信不给章（画一个气泡）。确认信不算回音。 */
export const REPLY_STAMP: Partial<Record<string, { text: string; tone: Tone }>> = {
  interview_invite: { text: '面试', tone: 'success' },
  written_test: { text: '笔试', tone: 'info' },
  assessment: { text: '测评', tone: 'info' },
  offer: { text: 'Offer', tone: 'success' },
  rejection: { text: '不合适', tone: 'neutral' },
};

/** 等他的那一封是哪一种（行尾记号给读屏的全称）。投递没有记号。 */
export const WAITING_NAME: Record<MailWaitingKind, string> = {
  apply: '投递邮件', reply: '回信', followup: '再争取一下', bounced: '被退回', failed_draft: '没写成', failed_send: '没发出去',
};

/** 等他的那一封用哪一组按钮字（和卡组同一套：mailLabels 的用途）。 */
export const WAITING_PURPOSE: Record<MailWaitingKind, 'apply' | 'reply' | 'followup'> = {
  apply: 'apply', reply: 'reply', followup: 'followup', bounced: 'apply', failed_draft: 'apply', failed_send: 'apply',
};

/** 这份申请的四步路（定制简历 → 写邮件 → 等你过目 → 已发出）每一步的样子：走过的、正在的、等你的、没到的。 */
export type StepState = 'done' | 'now' | 'ask' | 'todo';
export const STEP_NAMES = ['定制简历', '写邮件', '等你过目', '已发出'] as const;

export function stepsOf(row: Pick<MailBoardRow, 'station' | 'waiting'>): StepState[] {
  switch (row.station) {
    case 'ready': return ['todo', 'todo', 'todo', 'todo'];
    case 'writing': return ['done', 'now', 'todo', 'todo'];
    case 'sent': case 'replied': return ['done', 'done', 'done', 'done'];
    case 'waiting':
      // 回信、再争取是投出之后的事：原来那封已经发出去了
      if (row.waiting === 'reply' || row.waiting === 'followup') return ['done', 'done', 'done', 'done'];
      if (row.waiting === 'failed_draft') return ['done', 'ask', 'todo', 'todo'];
      return ['done', 'done', 'ask', 'todo'];
  }
}
