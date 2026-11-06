/**
 * 示例态：第一次打开一个功能、还没有他自己的东西时，用一份预设的示例把成果摆出来（2026-11-06 用户：不能是大片空白）。
 * 示例里只能翻看（切页签、展开细节）；动作按钮（发进对话、保存、删除、发出……）读这个上下文，一律不可点。
 * 示例不写库、不计入统计、不发给模型：示例数据只在 samples/ 里，组件拿到的是现成的对象，不会去请求。
 */
import { createContext, useContext } from 'react';

export const SampleModeContext = createContext(false);

/** 当前这块是不是示例。 */
export function useSampleMode(): boolean {
  return useContext(SampleModeContext);
}

const DAY_MS = 86_400_000;

/** 示例里的时间都相对「现在」：几天前 / 几天后，免得示例里的面试永远停在过去。 */
export function daysFromNow(days: number, now: number = Date.now()): string {
  return new Date(now + days * DAY_MS).toISOString();
}
