// 等待街机的游戏契约：纯逻辑（step / key）与绘制（draw）分离，
// 逻辑部分不碰 DOM，可在 node 单测里直接驱动。

/** 逻辑画布尺寸（CSS 像素），取掌机屏幕的 240×160。宿主按 devicePixelRatio 放大 backing store。 */
export const ARCADE_WIDTH = 240;
export const ARCADE_HEIGHT = 160;

export type ArcadeAction = 'up' | 'down' | 'left' | 'right' | 'action';

/** 屏幕配色，由宿主提供（掌机用固定的 LCD 配色）。 */
export interface ArcadePalette {
  bg: string;
  ink: string;
  muted: string;
  line: string;
  primary: string;
  accent: string;
  danger: string;
}

export interface ArcadeGame {
  readonly score: number;
  readonly over: boolean;
  reset(): void;
  /** 推进一帧；dtMs 已由宿主截断，避免切后台回来一步穿墙。 */
  step(dtMs: number): void;
  draw(ctx: CanvasRenderingContext2D, palette: ArcadePalette): void;
  key(action: ArcadeAction, down: boolean): void;
}

export type Rng = () => number;

export type ArcadeGameId = 'snake' | 'breakout' | 'runner';
