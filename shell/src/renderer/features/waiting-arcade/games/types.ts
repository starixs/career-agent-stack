// 等待街机的游戏契约：纯逻辑（step / key）与绘制（draw）分离，
// 逻辑部分不碰 DOM，可在 node 单测里直接驱动。

/** 逻辑画布尺寸（CSS 像素）。宿主按 devicePixelRatio 放大 backing store。 */
export const ARCADE_WIDTH = 288;
export const ARCADE_HEIGHT = 192;

export type ArcadeAction = 'up' | 'down' | 'left' | 'right' | 'action';

/** 从主题 CSS 变量解析出的颜色，宿主负责在主题切换时刷新。 */
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
