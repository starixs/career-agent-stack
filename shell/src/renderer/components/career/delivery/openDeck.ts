/**
 * 打开等你卡组（右栏「去处理」、悬浮球提醒、建议条、邮件往来里「看写好的那封」）。
 * 单独一个小模块：卡片里也要能定位卡组（邮件卡、邮件往来），不必反过来引用卡组组件本身。
 * 等你条还没挂上时先记下，挂上后打开一次。
 */
import { emitEvent } from '@/api/eventBus';

import { OPEN_DECK_EVENT } from './ReturnCard';

/** 等等你条挂上再打开的那一次（id 为空＝从最急的开始）；undefined＝没有待打开的。 */
let pendingDeck: { id: string | null } | undefined;

export function requestOpenDeck(id: string | null = null): void {
  pendingDeck = { id };
  emitEvent(OPEN_DECK_EVENT, { id: id ?? undefined });
}

export function peekPendingDeck(): { id: string | null } | undefined {
  return pendingDeck;
}

export function clearPendingDeck(): void {
  pendingDeck = undefined;
}
