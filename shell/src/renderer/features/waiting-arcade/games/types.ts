// 掌机游戏契约：纯逻辑（step / key）与绘制（draw）分离，
// 逻辑部分不碰 DOM，可在 node 单测里直接驱动。

/** 逻辑画布尺寸（CSS 像素），取掌机屏幕的 240×160。宿主按 devicePixelRatio 放大 backing store。 */
export const ARCADE_WIDTH = 240;
export const ARCADE_HEIGHT = 160;

/** 交给游戏的实体按键（START / SELECT 由屏幕自己处理）。 */
export type ArcadeAction = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'l' | 'r';

/** 游戏里值得出声的时刻，由屏幕映射成音效。 */
export type GameEvent = 'score' | 'bonus' | 'levelup' | 'hit' | 'clear' | 'big' | 'tick' | 'lose';

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
  readonly level: number;
  /** 有命数的游戏才提供，屏幕 HUD 画成小心形。 */
  readonly lives?: number;
  /** 自己画分数面板（如俄罗斯方块的侧栏），屏幕就不再叠 HUD。 */
  readonly ownHud?: boolean;
  reset(): void;
  /** 推进一帧；dtMs 已由宿主截断，避免切后台回来一步穿墙。 */
  step(dtMs: number): void;
  draw(ctx: CanvasRenderingContext2D, palette: ArcadePalette): void;
  key(action: ArcadeAction, down: boolean): void;
  /** 取走自上次调用以来发生的事件。 */
  drainEvents(): GameEvent[];
}

export type Rng = () => number;

export type ArcadeGameId = 'tetris' | 'snake' | 'breakout' | 'runner';

/** 事件队列的公共实现。 */
export abstract class EventfulGame {
  private events: GameEvent[] = [];

  protected emit(event: GameEvent): void {
    this.events.push(event);
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}

/** 从可选位置里随机挑一个；没有可选位置返回 null。 */
export function pick<T>(items: readonly T[], rng: Rng): T | null {
  return items.length ? items[Math.floor(rng() * items.length)] : null;
}
