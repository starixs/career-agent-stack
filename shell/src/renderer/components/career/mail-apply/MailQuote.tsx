/**
 * 引用对方来的一封信（回信预览顶上、邮件往来里的来信）：发件人、时间、正文；左边一条细线，不加底色。
 * 长信先露几行，点「展开全文」看全；短信不出这个按钮。
 */
import { useState } from 'react';

import type { MailIncoming } from '../../../../shared/careerMailApply';
import { whenText } from '../delivery/askText';

/** 超过这么多字或行就先收着（和 CSS 里 -webkit-line-clamp: 2 对应）：卡组只有 520 高，回信正文要留得下。 */
const QUOTE_CLAMP_CHARS = 60;
const QUOTE_CLAMP_LINES = 2;

export const isLongText = (text: string): boolean =>
  text.length > QUOTE_CLAMP_CHARS || text.split('\n').length > QUOTE_CLAMP_LINES;

/** 收着的时候把分段并成一段，两行里露的都是字（不让空行占掉一行、只剩一个省略号）。 */
const flatten = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();

export function MailQuote({ incoming }: { incoming: MailIncoming }) {
  const [open, setOpen] = useState(false);
  const long = isLongText(incoming.text);
  return (
    <blockquote className="cm-quote" data-testid="mail-incoming">
      <p className="cm-quote-head">
        <span className="cm-quote-from">{incoming.from}</span>
        <time dateTime={incoming.received_at}>{whenText(incoming.received_at)}</time>
        {long && (
          <button type="button" className="cm-more" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? '收起' : '展开全文'}
          </button>
        )}
      </p>
      {long && !open
        ? <p className="cm-quote-text is-clamped">{flatten(incoming.text)}</p>
        : <p className="cm-quote-text">{incoming.text}</p>}
    </blockquote>
  );
}
