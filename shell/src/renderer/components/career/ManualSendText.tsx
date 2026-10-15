/** 批准后要用户自己发出去的原文（招呼语 / 开放题回答）：原文 + 用户亲手点的「复制」。规则见 manualSendActions.ts。 */
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { copyPlainText } from '@/utils/clipboard';

import { careerApi } from './careerApi';
import { Button, ErrorRow } from './CareerPrimitives';
import { useCareerAction } from './useCareerData';

/**
 * 原文 + 「复制」按钮（复制失败时提示用户手动选中）+ 「我已发送」（POST mark-sent，needs_user → done）。
 * onSent 由页面决定发完之后怎么收尾（划掉这一行、刷新队列）。
 */
export function ManualSendText({ text, actionId, onSent }: { text: string; actionId: string; onSent: (label: string) => void }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const act = useCareerAction();
  const markSent = () => act.run(async () => { await careerApi.markActionSent(actionId); onSent('已发送'); });
  const copy = () => {
    copyPlainText(text).then(() => setState('copied'), () => setState('failed'));
  };
  return (
    <div className="mt-1.5" data-testid="manual-send-text">
      <div className="whitespace-pre-wrap break-words rounded-[4px] bg-[var(--inset)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)]">{text}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" onClick={copy}>
          {state === 'copied' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {state === 'copied' ? '已复制' : '复制'}
        </Button>
        <Button size="sm" variant="ghost" busy={act.busy} onClick={() => void markSent()}>我已发送</Button>
        <span role="status" className="text-xs text-[var(--muted)]">
          {state === 'failed' ? '复制没成功，请手动选中上面的文字' : '复制后到招聘平台上发出去'}
        </span>
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}
