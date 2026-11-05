/**
 * 建议条点下去以后怎么办（plan-r2 §B.4）：
 *  - say：发出原话；fill：填进输入框；
 *  - do：前端按白名单直接执行 action（start_feature 走功能市场同一个起头），不进对话、不叫模型——结果本身就是反馈（表出来了、卡组开了）。
 * 不认识的 action、或执行失败，退回发出原话，让小芽接着办。
 */
import { emitEvent } from '@/api/eventBus';
import { JOB_BOARD_TARGET, requestNavigation } from '@/features/career-shell/navModel';

import { careerApi } from './careerApi';
import { runFeatureStart } from './runFeatureStart';
import { suggestToChat } from './CareerPrimitives';
import { runAskPrimary } from './delivery/askPrimary';
import { deliveryApi } from './delivery/deliveryApi';
import { requestOpenDeck } from './delivery/WaitingDock';
import { FEATURES, isFeatureId, resolveFeatureStart } from '../../../shared/careerFeatures';
import type { SuggestAction, SuggestChip } from '../../../shared/careerSuggest';

type OpenAction = Extract<SuggestAction, { type: 'open' }>;
type FeatureAction = Extract<SuggestAction, { type: 'start_feature' }>;

/** 功能起头：和功能市场那张卡同一个执行器；公司名拼进预填句。不在清单里的 id 返回 false。 */
function startFeature(action: FeatureAction): boolean {
  if (!isFeatureId(action.feature_id)) return false;
  runFeatureStart(resolveFeatureStart(action.feature_id, action.args), `建议条 · ${FEATURES[action.feature_id].name}`);
  return true;
}

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
    // ask_choose：网页弹窗的选择题直接选，和卡组里选同一个接口；后台从当前页接着填
    case 'ask_choose': await deliveryApi.choose(action.ask_id, action.choice); return true;
    case 'open': openSurface(action); return true;
    case 'start_feature': return startFeature(action);
    default: return false;
  }
}

/** 填空格里的空（"大概 __ 人参加："）：两个以上下划线或全角下划线。 */
export const FILL_BLANK = /_{2,}|＿+/;
/** 空统一写成这个，看得见、好选中。 */
export const BLANK = '＿＿';

/** 半句里的空统一成 BLANK；没有空的原样。 */
export const fillText = (text: string): string => text.replace(FILL_BLANK, BLANK);

/** 填进输入框后把空选中：他一打字就换掉空。输入框是对话那边异步写的，等它写进来再选。 */
export function selectBlank(getInput: () => HTMLTextAreaElement | null | undefined, tries = 5): void {
  setTimeout(() => {
    const el = getInput();
    const at = el ? el.value.indexOf(BLANK) : -1;
    if (el && at >= 0) { el.focus(); el.setSelectionRange(at, at + BLANK.length); return; }
    if (tries > 1) selectBlank(getInput, tries - 1);
  }, 0);
}

/** 把一条 fill 填进输入框；有空就把光标放到空上。 */
export function prefillChip(chip: SuggestChip, getInput?: () => HTMLTextAreaElement | null | undefined): void {
  const text = fillText(chip.text);
  suggestToChat(text, undefined, 'prefill');
  if (getInput && text.includes(BLANK)) selectBlank(getInput);
}

/** 点了（或 Enter）一条建议；getInput 用来把光标放到填空格的空上。 */
export async function runSuggestion(chip: SuggestChip, getInput?: () => HTMLTextAreaElement | null | undefined): Promise<void> {
  if (chip.kind === 'fill') { prefillChip(chip, getInput); return; }
  if (chip.kind !== 'do' || !chip.action) { suggestToChat(chip.text); return; }
  try {
    if (await runAction(chip.action)) return;
    console.warn('[career-suggest] unknown action, sent as text:', chip.seed_id ?? chip.slot);
  } catch (error: unknown) {
    console.warn(`[career-suggest] action ${chip.action.type} failed, sent as text:`, error instanceof Error ? error.message : error);
  }
  suggestToChat(chip.text);
}
