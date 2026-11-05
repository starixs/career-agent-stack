/** 轮末推送的存放（plan-r4 §5.3）：形状不对不收、按会话分开、旧的不盖新的。 */
import { beforeEach, describe, expect, it } from 'vitest';

import { emitEvent } from '@/api/eventBus';

import { acceptSuggestPush, resetSuggestStore, suggestPushOf } from './suggestStore';
import { CAREER_SUGGEST_EVENT } from '../../../shared/careerSuggest';

const CHIP = { text: '再投 5 家', slot: 'next', mode: 'advance', kind: 'say', seed_id: null };
const raw = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1', turn_id: 't1', assistant_message_id: 'a1', chips: [CHIP], scene: 'S14', source: 'hook', degraded: false, ts: 1_000, ...over,
});

describe('suggestStore', () => {
  beforeEach(() => { resetSuggestStore(); });

  it('经 eventBus 收进来，按会话取', () => {
    emitEvent(CAREER_SUGGEST_EVENT, raw());
    expect(suggestPushOf('s1')?.assistant_message_id).toBe('a1');
    expect(suggestPushOf('s2')).toBeNull();
    expect(suggestPushOf(null)).toBeNull();
  });

  it('形状不对不收（缺 sessionId / scene）', () => {
    expect(acceptSuggestPush(raw({ sessionId: '' }))).toBe(false);
    expect(acceptSuggestPush(raw({ scene: undefined }))).toBe(false);
    expect(acceptSuggestPush('nope')).toBe(false);
    expect(suggestPushOf('s1')).toBeNull();
  });

  it('晚到的旧推送不盖新的；新的覆盖旧的', () => {
    acceptSuggestPush(raw({ assistant_message_id: 'a2', ts: 2_000 }));
    expect(acceptSuggestPush(raw({ assistant_message_id: 'a1', ts: 1_000 }))).toBe(false);
    expect(suggestPushOf('s1')?.assistant_message_id).toBe('a2');
    acceptSuggestPush(raw({ assistant_message_id: 'a3', ts: 3_000 }));
    expect(suggestPushOf('s1')?.assistant_message_id).toBe('a3');
  });

  it('chips 只留形状对的', () => {
    acceptSuggestPush(raw({ chips: [CHIP, { text: '' }] }));
    expect(suggestPushOf('s1')?.chips).toHaveLength(1);
  });
});
