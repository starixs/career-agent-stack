/**
 * 建议条点下去以后怎么办（plan-r2 §B.4）：
 *  - say：发出原话；fill：填进输入框；
 *  - do：前端按白名单直接执行 action，不进对话、不叫模型——结果本身就是反馈（表出来了、卡组开了）。
 * 不认识的 action、或执行失败，退回发出原话，让小芽接着办。
 */
import { emitEvent } from '@/api/eventBus';
import { JOB_BOARD_TARGET, requestNavigation } from '@/features/career-shell/navModel';

import { careerApi } from './careerApi';
import { suggestToChat } from './CareerPrimitives';
import { runAskPrimary } from './delivery/askPrimary';
import { requestOpenDeck } from './delivery/WaitingDock';
import type { SuggestAction, SuggestChip } from '../../../shared/careerSuggest';

type OpenAction = Extract<SuggestAction, { type: 'open' }>;

function openSurface(action: OpenAction): void {
  if (action.surface === 'live') { emitEvent('career:focus', { surface: 'live_drawer' }); return; }
  if (action.surface === 'dossier' && action.id) { emitEvent('career:focus', { surface: 'dossier', application_id: action.id }); return; }
  if (action.surface === 'dossier') { requestNavigation({ kind: 'career-dossier', view: 'line' }); return; }
  if (action.surface === 'jobs') { requestNavigation(JOB_BOARD_TARGET); return; }
  requestNavigation({ kind: 'career-material', view: 'resume' });
}

/** 执行一个 action；返回 false 表示不认识，交给调用方退回发话。 */
async function runAction(action: SuggestAction): Promise<boolean> {
  switch (action.type) {
    case 'propose_batch': await careerApi.proposeBatch(action.job_ids ? { job_ids: action.job_ids } : {}); return true;
    case 'start_card': await careerApi.startBatchPick(action.card_id, action.job_ids); return true;
    case 'dismiss_card': await careerApi.dismissCard(action.card_id); return true;
    case 'open_deck': requestOpenDeck(action.ask_id ?? null); return true;
    // ask_primary：和卡组主按钮同一套落库（都投出 / 再试一次 / 都开始）；要他先填、已办掉的退回打开卡组
    case 'ask_primary': await runAskPrimary(action.ask_id); return true;
    case 'open': openSurface(action); return true;
    default: return false;
  }
}

/** 点了（或 Enter）一条建议。 */
export async function runSuggestion(chip: SuggestChip): Promise<void> {
  if (chip.kind === 'fill') { suggestToChat(chip.text, undefined, 'prefill'); return; }
  if (chip.kind !== 'do' || !chip.action) { suggestToChat(chip.text); return; }
  try {
    if (await runAction(chip.action)) return;
    console.warn('[career-suggest] unknown action, sent as text:', chip.seed_id ?? chip.slot);
  } catch (error: unknown) {
    console.warn(`[career-suggest] action ${chip.action.type} failed, sent as text:`, error instanceof Error ? error.message : error);
  }
  suggestToChat(chip.text);
}
