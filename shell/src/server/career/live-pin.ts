/**
 * 现场画面钉在哪一页（Global 侧车进程内）。
 *
 * 并行投递时，后台每开始填另一家，浏览器的「选中页」就换过去，现场画面原来跟着选中页走，要你登录的那一页
 * 一下就被切走了（用户 2026-10-30）。登录之旅进行时把画面和你的操作都钉在当前带你过的那一家；
 * 后台其余几家照样在别的标签页填，不抢画面，你接管也不让后台停下。
 */
export interface LivePin { sessionKey: string; appKey: string; askId: string; handoffId: string; index: number; total: number }

let pin: LivePin | null = null;

/** 登录之旅换到下一家时，把他之前点的那家放下：画面跟到要他登录的这一家；同一家内的更新不动他的选择。 */
export function setLivePin(next: LivePin | null): void {
  if (next && next.appKey !== pin?.appKey) viewApp = null;
  pin = next;
}
export function livePin(): LivePin | null { return pin; }
/** 登录之旅进行中：后台不因为你在接管而停下，也不把画面切到新开的网申上。 */
export const loginJourneyActive = (): boolean => pin !== null;

/**
 * 助理正在 browser_wait_user 里等你（扫码、短信码……）：这时你点「交还」，等待自己会看到并把新页面交回助理，
 * 现场抽屉就不要再往对话里补一句，否则助理同一件事会被叫两次。只在 Global 侧车进程内计数。
 */
let userWaits = 0;
export function beginUserWait(): () => void {
  userWaits++;
  let ended = false;
  return () => { if (!ended) { ended = true; userWaits--; } };
}
export const userWaitActive = (): boolean => userWaits > 0;

/**
 * 他在现场窗里点了某一家（几家一起投时在它们之间切换，用户 2026-11-02「只能看到美团这一家」）：
 * 画面和他的操作都落在这一家的页面上，直到他换一家或这一家的页面关了。
 * 他主动点的比登录之旅钉住的优先（2026-11-05「切换画面不会跟着切换」：登录之旅在走时，点别家画面纹丝不动）；
 * 登录之旅换到下一家时会把这条选择放下（见 setLivePin）。
 */
let viewApp: string | null = null;
export function setViewApp(appKey: string | null): void { viewApp = appKey; }
export function viewedApp(): string | null { return viewApp; }
/** 现场窗此刻该看哪一家：他点的那家优先，其次是登录之旅钉住的那家。 */
export function liveTarget(): { appKey: string; sessionKey: string | null } | null {
  if (viewApp) return { appKey: viewApp, sessionKey: null };
  return pin ? { appKey: pin.appKey, sessionKey: pin.sessionKey } : null;
}
