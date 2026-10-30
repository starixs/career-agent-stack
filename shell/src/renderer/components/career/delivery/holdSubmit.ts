/**
 * 投前过目点了「先不投 / 先不提交」之后（立场 9：不让助理开口问「接下来怎么办」，给好选项）：
 *  - 在页面上改：打开浏览器现场，改完回来点「就这样投出」；
 *  - 这家不投了：拒绝这次提交，申请标成跳过（服务端顺带关掉页面）；
 *  - 晚点再说：留着，挪到最后。
 * 等你条的卡组和对话里的提交卡共用这一份。
 */
import { careerApi } from '../careerApi';
import { openLiveDrawer } from '../CareerLiveDrawer';

export type HoldChoice = 'page' | 'drop' | 'later';
/** 落库了的返回 'resolved'；只是先放着的返回 'snoozed'；页面上改的那件还在等你，返回 'kept'。 */
export type HoldOutcome = 'resolved' | 'snoozed' | 'kept';

export const HOLD_OPTIONS: ReadonlyArray<{ choice: HoldChoice; label: string }> = [
  { choice: 'page', label: '在页面上改' }, { choice: 'drop', label: '这家不投了' }, { choice: 'later', label: '晚点再说' },
];

export async function holdSubmit(actionIds: string[], choice: HoldChoice): Promise<HoldOutcome> {
  if (choice === 'page') { openLiveDrawer(); return 'kept'; }
  if (choice === 'later') return 'snoozed';
  await careerApi.reviewActions(actionIds, 'rejected', { drop: true });
  return 'resolved';
}
