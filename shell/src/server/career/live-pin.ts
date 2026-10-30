/**
 * 现场画面钉在哪一页（Global 侧车进程内）。
 *
 * 并行投递时，后台每开始填另一家，浏览器的「选中页」就换过去，现场画面原来跟着选中页走，要你登录的那一页
 * 一下就被切走了（用户 2026-10-30）。登录之旅进行时把画面和你的操作都钉在当前带你过的那一家；
 * 后台其余几家照样在别的标签页填，不抢画面，你接管也不让后台停下。
 */
export interface LivePin { sessionKey: string; appKey: string; askId: string; handoffId: string; index: number; total: number }

let pin: LivePin | null = null;

export function setLivePin(next: LivePin | null): void { pin = next; }
export function livePin(): LivePin | null { return pin; }
/** 登录之旅进行中：后台不因为你在接管而停下，也不把画面切到新开的网申上。 */
export const loginJourneyActive = (): boolean => pin !== null;
