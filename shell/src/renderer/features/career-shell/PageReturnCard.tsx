/**
 * 从页面输入框（PageAskBar）发来的那一轮回复结束后，挂在回复下面的「回到 XX」打破式卡片。
 */
import type { Message } from '@/types/chat';

import { careerContextSurface } from '../../../shared/systemReminder';
import { BreakoutCard, PageAnchor } from './BreakoutCard';
import { requestNavigation } from './navModel';
import { pageLabel, parsePageSurface, type PageTarget } from './pageSurface';

function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('\n');
}

/**
 * 每一轮「页面发来的用户消息 → 助理回复」里，最后一条助理消息挂一张回程卡片。
 * 返回 助理消息 id → 原页面。
 */
export function pageReturnTargets(messages: readonly Message[]): Map<string, PageTarget> {
  const out = new Map<string, PageTarget>();
  let pending: PageTarget | null = null;
  let lastAssistant: string | null = null;
  const flush = () => {
    if (pending && lastAssistant) out.set(lastAssistant, pending);
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      pending = parsePageSurface(careerContextSurface(textOf(message)));
      lastAssistant = null;
    } else if (message.role === 'assistant') {
      lastAssistant = message.id;
    }
  }
  flush();
  return out;
}

export function PageReturnCard({ target }: { target: PageTarget }) {
  const label = pageLabel(target);
  return (
    <div className="px-4 py-1">
      <BreakoutCard
        testId="career-page-return-card"
        anchor={<PageAnchor />}
        title={label}
        overline="你在这一页提的事，助理已经处理"
        status={{ tone: 'idle', text: '已处理' }}
        action={{ label: `回到${label}`, onOpen: () => requestNavigation(target) }}
      />
    </div>
  );
}
