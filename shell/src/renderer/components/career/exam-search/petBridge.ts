/**
 * 笔试助力 ⇄ 宠物：开考 / 考完 / 托盘有变时通知宠物和它的小面板重新取一次 `live`。
 * 宠物窗口和主窗口是不同的 WebView，只能经 Rust 的 cmd_fb_relay 转；状态本身在侧车（`/exam-search/live`）。
 */
import { invoke } from '@tauri-apps/api/core';

import { isTauriEnvironment } from '@/utils/browserMock';

export const EXAM_PET_EVENT = 'fb:exam-changed';

export function notifyPet(targets: ReadonlyArray<'ball' | 'companion'> = ['ball', 'companion']): void {
  if (!isTauriEnvironment()) return;
  for (const target of targets) {
    void invoke('cmd_fb_relay', { target, event: EXAM_PET_EVENT, payload: {} })
      .catch(err => console.warn(`[exam-search] 通知宠物（${target}）失败:`, err));
  }
}
