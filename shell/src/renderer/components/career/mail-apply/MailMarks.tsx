/**
 * 邮件投递工作台列表行尾的记号：状态用形状和颜色说，不写字（读屏的全称放 aria-label）。
 *  - 可以投（开始条）：截止日的日期块、标星；在写：转圈；
 *  - 等你：回信是气泡、再争取是往返箭头、被退回是红色警示、没写成 / 没发出去是红色圆圈叉，投递不画；
 *  - 有回音：一枚章（面试 / 笔试 / 测评 / Offer / 不合适），真人回信是气泡；已发出不画。
 */
import { CircleX, Loader2, MessageCircle, Repeat2, TriangleAlert } from 'lucide-react';

import type { MailBoardRow, MailWaitingKind } from '../../../../shared/careerMailApply';
import { Stamp } from '../skills/visual';
import { REPLY_STAMP, WAITING_NAME } from './mailBoard';

const ICON = 'h-4 w-4 shrink-0';

/** 截止日：上面一道墨线（像日历撕页），下面日和月。 */
export function MiniDate({ iso }: { iso: string }) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    <span className="cm-date" role="img" aria-label={`截止 ${d.getMonth() + 1} 月 ${d.getDate()} 日`}>
      <b>{d.getDate()}</b><span>{d.getMonth() + 1}月</span>
    </span>
  );
}

const WAITING_ICON: Partial<Record<MailWaitingKind, typeof MessageCircle>> = {
  reply: MessageCircle, followup: Repeat2, bounced: TriangleAlert, failed_draft: CircleX, failed_send: CircleX,
};

export function WaitingMark({ kind }: { kind: MailWaitingKind }) {
  const Icon = WAITING_ICON[kind];
  if (!Icon) return null;
  const red = kind === 'bounced' || kind === 'failed_draft' || kind === 'failed_send';
  return <Icon className={`${ICON} ${red ? 'text-[var(--danger)]' : 'text-[var(--ink-2)]'}`} strokeWidth={1.75} role="img" aria-label={WAITING_NAME[kind]} />;
}

export function ReplyMark({ kind }: { kind: string | null }) {
  const stamp = kind ? REPLY_STAMP[kind] : undefined;
  if (stamp) return <Stamp tone={stamp.tone}>{stamp.text}</Stamp>;
  return <MessageCircle className={`${ICON} text-[var(--ink-2)]`} strokeWidth={1.75} role="img" aria-label="回信了" />;
}

export const Writing = () => <Loader2 className={`${ICON} animate-spin text-[var(--muted)]`} role="img" aria-label="在写" />;

/** 每一站行尾放什么。 */
export function RowMark({ row }: { row: MailBoardRow }) {
  switch (row.station) {
    case 'ready': return (
      <span className="flex items-center gap-2">
        {row.target && <span className="text-xs text-[var(--ink-2)]" role="img" aria-label="目标岗位">★</span>}
        {row.deadline && <MiniDate iso={row.deadline} />}
      </span>
    );
    case 'writing': return <Writing />;
    case 'waiting': return row.waiting ? <WaitingMark kind={row.waiting} /> : null;
    case 'sent': return null;
    case 'replied': return <ReplyMark kind={row.reply_kind} />;
  }
}
