/**
 * 一份申请的邮件往来（P2.8）：按时间自上而下。
 *  - 发出的：墨色，用途 + 时间、标题，正文点开看，附件签；
 *  - 对方来的：发件人 + 时间（认出的种类小字跟在后面），正文先露几行，可展开；
 *  - 等你的那封：钢笔蓝一行，点了打开卡组定位到它（发信只在卡组里）。
 * 没有外壳底色描边（规范 §6.1）。
 */
import { Paperclip } from 'lucide-react';
import { useState } from 'react';

import type { MailPurpose, MailThreadItem, MailThreadView } from '../../../../shared/careerMailApply';
import { whenText } from '../delivery/askText';
import { openDeckForMail } from './mailActions';
import { MailQuote } from './MailQuote';

import './mail-apply.css';

const OUT_LABEL: Record<MailPurpose, string> = { apply: '投递邮件', followup: '跟进', reply: '回信' };
const PENDING_LABEL: Record<MailPurpose, string> = { apply: '看写好的投递邮件', followup: '看写好的跟进', reply: '看写好的回信' };
/**
 * 来信的种类（服务端归类）说成人话；其它（other / jd / 没归类）不标。
 * 退信的种类名服务端还没定，先认 bounce / bounced（交付报告里写明）。
 */
export const IN_KIND_LABEL: Partial<Record<string, string>> = {
  application_received: '确认信', interview_invite: '面试邀请', written_test: '笔试', assessment: '测评', rejection: '不合适', offer: 'Offer',
  bounce: '被退回', bounced: '被退回',
};

function OutRow({ item }: { item: MailThreadItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="cm-th is-out" data-testid={`thread-out-${item.id}`}>
      <p className="cm-th-head"><b>{OUT_LABEL[item.purpose ?? 'apply']}</b><span>发给 {item.counterpart}</span><time dateTime={item.at}>{whenText(item.at)}</time></p>
      <p className="cm-th-subject">{item.subject}</p>
      {open && <p className="cm-th-body">{item.body}</p>}
      <div className="cm-th-foot">
        {item.attachments.map(name => (
          <span key={name} className="cm-th-file" title={name}><Paperclip className="cm-file-icon" aria-hidden /><span className="cm-file-name">{name}</span></span>
        ))}
        <button type="button" className="cm-more" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? '收起正文' : '看正文'}</button>
      </div>
    </li>
  );
}

function InRow({ item }: { item: MailThreadItem }) {
  const kind = item.kind ? IN_KIND_LABEL[item.kind] : undefined;
  return (
    <li className="cm-th is-in" data-testid={`thread-in-${item.id}`}>
      {kind && <p className="cm-th-kind">{kind}</p>}
      <MailQuote incoming={{ from: item.counterpart, text: item.body, received_at: item.at }} />
    </li>
  );
}

function PendingRow({ item }: { item: MailThreadItem }) {
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setError(null);
    openDeckForMail(item.action_id ? [item.action_id] : []).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[career] mail-apply open deck FAILED action=', item.action_id, message);
      setError('没能打开，请重试');
    });
  };
  return (
    <li className="cm-th is-pending" data-testid={`thread-pending-${item.id}`}>
      <button type="button" className="cd-go-text" onClick={open}>{PENDING_LABEL[item.purpose ?? 'apply']} →</button>
      <p className="cm-th-subject">{item.subject}</p>
      {error && <p role="alert" className="cd-err">{error}</p>}
    </li>
  );
}

export function MailThread({ thread }: { thread: MailThreadView }) {
  return (
    <ol className="cm-th-list" aria-label={`${thread.company} 的邮件往来`} data-testid="mail-thread">
      {thread.items.map(item => (item.direction === 'out'
        ? <OutRow key={item.id} item={item} />
        : item.direction === 'in' ? <InRow key={item.id} item={item} /> : <PendingRow key={item.id} item={item} />))}
    </ol>
  );
}
