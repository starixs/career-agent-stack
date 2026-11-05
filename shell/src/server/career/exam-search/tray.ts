/**
 * 宠物身上挂着的截图：开考后点一下宠物就框选截一张（怎么截见 capture.ts），先挂着，截够了一口气发出去。
 * 托盘只在内存里、按场分开：发出去就清空（记录里只存认出来的文字，不存图），侧车重启就没了。
 */
import type { Capture } from './capture-common';

/** 一次最多发几张：再多模型认题变慢，也很少有一道题跨这么多屏。 */
export const MAX_SHOTS_PER_SEND = 6;

export interface TrayShot extends Capture { id: string; captured_at: string }
export interface TrayShotView { id: string; thumb: string; captured_at: string }

export class ShotTray {
  private readonly shots = new Map<string, TrayShot[]>();
  private seq = 0;

  list(sessionId: string): TrayShot[] {
    return this.shots.get(sessionId) ?? [];
  }

  /** 给界面看的：只带缩略图。 */
  view(sessionId: string): TrayShotView[] {
    return this.list(sessionId).map(({ id, thumb, captured_at }) => ({ id, thumb, captured_at }));
  }

  add(sessionId: string, capture: Capture): TrayShot {
    const shot = { id: `shot_${++this.seq}`, ...capture, captured_at: new Date().toISOString() };
    this.shots.set(sessionId, [...this.list(sessionId), shot]);
    return shot;
  }

  remove(sessionId: string, shotId: string): boolean {
    const before = this.list(sessionId);
    const after = before.filter(s => s.id !== shotId);
    this.shots.set(sessionId, after);
    return after.length < before.length;
  }

  /** 发送时整盘取走（取走即清空）。 */
  take(sessionId: string): TrayShot[] {
    const taken = this.list(sessionId);
    this.shots.delete(sessionId);
    return taken;
  }

  clear(): void {
    this.shots.clear();
  }
}

/** 整个侧车一份：宠物、小面板、主窗口看到的是同一个托盘。 */
export const examTray = new ShotTray();
