/**
 * 卡组外直接跑一件事的主动作（建议条「备好的 3 家都投出」「再试一次这 3 家」「这 N 家都开始」）：
 * 取当前要你的事，找到那一件，按卡组主按钮同一套落库（goAsk），再通知各处重取。
 * 已经处理掉的（找不到）、或要他先填 / 先选 / 先看一眼的，打开卡组停在那一件，让他在卡组里办。
 */
import { emitEvent } from '@/api/eventBus';

import { careerApi } from '../careerApi';
import { deliveryApi, localMidnightIso, type AskKind } from './deliveryApi';
import { goAsk, type AskOutcome, type Respond } from './useAskActions';
import { requestOpenDeck } from './WaitingDock';

/** 主动作要他先给东西的：缺信息要填值、选择要选项、投出了吗要他看过页面。 */
const NEEDS_DECK: ReadonlySet<AskKind> = new Set<AskKind>(['info', 'choice', 'confirm']);

/** 卡组外没有卡片上下文：审批直接落库，失败抛出（由调用方退回发话）。 */
const respondDirect: Respond = async (ids, decision) => {
  await careerApi.reviewActions(ids, decision);
  return true;
};

/** 跑完返回结果；'deck' 表示退回打开了卡组。 */
export async function runAskPrimary(askId: string): Promise<AskOutcome | 'deck'> {
  const { asks } = await deliveryApi.asks(localMidnightIso());
  const ask = asks.find(a => a.id === askId);
  if (!ask || NEEDS_DECK.has(ask.kind)) {
    requestOpenDeck(ask ? askId : null);
    return 'deck';
  }
  const outcome = await goAsk(ask, respondDirect, {});
  console.info(`[career-suggest] ask_primary ${ask.kind} ${askId} -> ${outcome}`);
  // 等你条 / 右栏 / 各页按 data-changed 重取，刚办掉的那件自然消失
  emitEvent('career:data-changed', { tables: [] });
  return outcome;
}
