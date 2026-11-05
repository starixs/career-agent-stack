/**
 * 建议条的取数：一轮说完后去取一次，整条一次出、不先出后补（plan-r2 §B.5、§B.6）。
 * 视图在 SuggestChips.tsx，点了以后怎么办在 suggestActions.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { track } from '@/analytics';
import type { Message } from '@/types/chat';

import { careerApi } from './careerApi';
import type { SuggestChip, SuggestRequest } from '../../../shared/careerSuggest';

/** 埋点里一条建议的 action 类型；没有 action 记空串。 */
export const actionTypeOf = (chip: SuggestChip): string => chip.action?.type ?? '';

/** 一轮说完后去取建议。`turnKey` 变了（新的一轮说完）才重新取；在说话时、或结果不属于这一轮时不显示。 */
export function useCareerSuggestions({ enabled, streaming, turnKey, request }: {
  enabled: boolean;
  streaming: boolean;
  /** 最后一条消息的 id：变了说明有新的一轮。 */
  turnKey: string | null;
  request: () => SuggestRequest;
}) {
  const [got, setGot] = useState<{ key: string | null; chips: SuggestChip[] }>({ key: null, chips: [] });
  const requestRef = useRef(request);
  // 只要最新的取法，不让它驱动重取：重取只跟着新的一轮（turnKey）走
  useEffect(() => { requestRef.current = request; });
  useEffect(() => {
    if (!enabled || streaming) return;
    let alive = true;
    careerApi.suggest(requestRef.current())
      .then(next => {
        if (!alive) return;
        setGot({ key: turnKey, chips: next });
        if (next.length) {
          track('career_suggest_shown', {
            slots: next.map(c => c.slot).join(','),
            kind: next.map(c => c.kind).join(','),
            action_type: next.map(actionTypeOf).join(','),
          });
        }
      })
      .catch((error: unknown) => console.warn('[career-suggest] fetch failed:', error instanceof Error ? error.message : error));
    return () => { alive = false; };
  }, [enabled, streaming, turnKey]);
  const used = useCallback((chip: SuggestChip, how: 'click' | 'tab' | 'key') => {
    track('career_suggest_used', { slot: chip.slot, kind: chip.kind, action_type: actionTypeOf(chip), seed_id: chip.seed_id ?? '', how });
    setGot({ key: null, chips: [] });
  }, []);
  const chips = enabled && !streaming && got.key === turnKey ? got.chips : [];
  return { chips, used };
}

/** 隐藏上下文（system-reminder）不算他说的话。 */
const HIDDEN_CONTEXT = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** 一条消息里给人看的文字。 */
export function visibleText(message: Message | undefined): string {
  if (!message) return '';
  const raw = typeof message.content === 'string'
    ? message.content
    : message.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n');
  return raw.replace(HIDDEN_CONTEXT, '').trim();
}

export const lastOf = (messages: readonly Message[], role: Message['role']): Message | undefined => [...messages].reverse().find(m => m.role === role);
