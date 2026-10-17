/**
 * 对话内审核卡片（提交 / 发送等待你批准的动作）的稳定 id。
 *
 * Session 工具经 card() 落库推送（带 toolUseId，挂在产生它的那次工具调用下面）；Global 后台
 * （批量投递 / 提交执行器）只推 `career:review` 事件，渲染层按同一个 id 合并成卡片。两边必须算出同一个 id，
 * 否则同一个动作会出现两张卡。
 */
export const REVIEW_CARD_KIND = 'review';

export function reviewCardId(actionIds: readonly string[]): string {
  return `review:${actionIds.join(',')}`;
}
