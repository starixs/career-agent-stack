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

/** 调色板里的颜色名，或直接给十六进制色。 */
export type FxColor = keyof ArcadePalette | `#${string}`;

/**
 * 反馈请求：游戏只说「这里发生了什么」，表现（粒子、飘字、震屏、定格、横幅、音高）
 * 统一由屏幕负责，五个游戏手感一致。坐标是屏幕逻辑坐标（240×160）。
 */
export type Fx =
  /** 打击：在 (x, y) 炸开一团碎片。power 0~1 决定数量与速度。 */
  | { kind: 'burst'; x: number; y: number; color: FxColor; power?: number }
  /** 收获：从 (x, y) 飘起一行字，如 +100。 */
  | { kind: 'popup'; x: number; y: number; text: string; color?: FxColor }
  /** 震屏，power 0~1。 */
  | { kind: 'shake'; power: number }
  /** 命中定格：逻辑暂停几十毫秒，让重击「顿」一下。 */
  | { kind: 'hitstop'; ms: number }
  /** 全屏闪一下。 */
  | { kind: 'flash'; color?: FxColor; alpha?: number }
  /** 成长：屏幕中央弹出横幅，如 LEVEL UP。 */
  | { kind: 'banner'; text: string; sub?: string }
  /** 连击：第 n 连，得分音一级比一级高。 */
  | { kind: 'combo'; n: number };

export interface ArcadeGame {
  readonly score: number;
  readonly over: boolean;
  readonly level: number;
  /** 第几个场景；每变一次屏幕换一套配色和环境。不给就跟 level 走（幸存者的 level 是经验等级，场景跟波次）。 */
  readonly stage?: number;
  /** 有命数的游戏才提供，屏幕 HUD 画成小心形。 */
  readonly lives?: number;
  /** 自带屏幕配色（如坦克的暗色屏）；不给就用掌机默认的 LCD 配色。HUD 与反馈层跟着换。 */
  readonly palette?: ArcadePalette;
  /** 自己画分数面板（如俄罗斯方块的侧栏），屏幕就不再叠 HUD。 */
  readonly ownHud?: boolean;
  reset(): void;
  /** 推进一帧；dtMs 已由宿主截断，避免切后台回来一步穿墙。 */
  step(dtMs: number): void;
  draw(ctx: CanvasRenderingContext2D, palette: ArcadePalette): void;
  key(action: ArcadeAction, down: boolean): void;
  /** 取走自上次调用以来发生的事件。 */
  drainEvents(): GameEvent[];
  /** 取走自上次调用以来的反馈请求。 */
  drainFx(): Fx[];
}

export type Rng = () => number;

export type ArcadeGameId = 'tetris' | 'snake' | 'breakout' | 'runner' | 'tank' | 'survivor' | 'shooter' | 'shredder';

/** 事件与反馈队列的公共实现。 */
export abstract class EventfulGame {
  private events: GameEvent[] = [];
  private effects: Fx[] = [];

  protected emit(event: GameEvent): void {
    this.events.push(event);
  }

  protected fx(...effects: Fx[]): void {
    this.effects.push(...effects);
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  drainFx(): Fx[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }
}

/** 从可选位置里随机挑一个；没有可选位置返回 null。 */
export function pick<T>(items: readonly T[], rng: Rng): T | null {
  return items.length ? items[Math.floor(rng() * items.length)] : null;
}
