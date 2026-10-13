/**
 * 页面底部的统一输入框：在任何工作页上都能直接跟助理说话。
 * 发出后跳回对话（App 订阅 `career:chat-suggest` 切到对话），这一轮回复结束时
 * 对话里会出现一张「回到 XX」卡片（PageReturnCard），点了回到这一页看结果。
 * 不和页面捆绑：页面只负责带上「从哪一页来」，处理全在对话里。
 */
import { ArrowUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { suggestToChat } from '@/components/career/CareerPrimitives';

import { pageSurfaceId, type PageTarget } from './pageSurface';

export function PageAskBar({ target, placeholder, actions, refs }: {
  target: PageTarget;
  placeholder: string;
  /** 输入框旁边的页面专属快捷按钮，比如岗位收藏页的「AI 找工作」。 */
  actions?: ReactNode;
  /** 用户当前正在看的对象 id，一并带给助理。 */
  refs?: Record<string, string | null | undefined>;
}) {
  const [text, setText] = useState('');
  const send = () => {
    const value = text.trim();
    if (!value) return;
    suggestToChat(value, { surface: pageSurfaceId(target), refs });
    setText('');
  };
  return (
    <div data-testid="page-ask-bar" className="sticky bottom-0 z-10 bg-gradient-to-t from-[var(--bg)] from-60% to-[var(--bg-a0)] px-6 pb-4 pt-6">
      <div className="mx-auto flex max-w-[880px] items-center gap-2">
        <form
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--line-2)] bg-[var(--paper)] py-1.5 pl-4 pr-1.5 shadow-sm focus-within:border-[var(--primary)]"
          onSubmit={event => { event.preventDefault(); send(); }}
        >
          <label className="sr-only" htmlFor="page-ask-input">问助理</label>
          <input
            id="page-ask-input"
            value={text}
            onChange={event => setText(event.target.value)}
            placeholder={placeholder}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] focus:outline-none"
          />
          <button
            type="submit"
            aria-label="发送给助理"
            disabled={!text.trim()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--primary)] text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:bg-[var(--inset)] disabled:text-[var(--subtle)]"
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </button>
        </form>
        {actions}
      </div>
    </div>
  );
}
