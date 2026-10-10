// 贪吃蛇：每吃 5 个果子升一级并提速；每第 4 个果子后冒出限时金苹果（高分）；
// 从第 3 级起每次升级在地图上长出障碍块，越往后越挤。

import {
  ARCADE_HEIGHT,
  ARCADE_WIDTH,
  EventfulGame,
  pick,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

const CELL = 10;
export const SNAKE_COLS = ARCADE_WIDTH / CELL; // 24
export const SNAKE_ROWS = ARCADE_HEIGHT / CELL; // 16
const APPLES_PER_LEVEL = 5;
const GOLDEN_EVERY = 4;
export const GOLDEN_MS = 6000;
const OBSTACLES_FROM_LEVEL = 3;
const OBSTACLES_PER_LEVEL = 3;
const MAX_OBSTACLES = 24;

export interface Point { x: number; y: number }

const DIRS: Partial<Record<ArcadeAction, Point>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

export class SnakeGame extends EventfulGame implements ArcadeGame {
  score = 0;
  over = false;
  level = 1;
  eaten = 0;
  body: Point[] = [];
  food: Point = { x: -1, y: -1 };
  golden: { at: Point; msLeft: number } | null = null;
  obstacles: Point[] = [];
  private dir: Point = { x: 1, y: 0 };
  /** 一个 tick 内连按两次方向键（如 上→左）都要生效，否则急转会被吞掉。 */
  private pending: Point[] = [];
  private acc = 0;

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  reset(): void {
    const y = Math.floor(SNAKE_ROWS / 2);
    this.body = [{ x: 6, y }, { x: 5, y }, { x: 4, y }];
    this.dir = { x: 1, y: 0 };
    this.pending = [];
    this.acc = 0;
    this.score = 0;
    this.level = 1;
    this.eaten = 0;
    this.over = false;
    this.golden = null;
    this.obstacles = [];
    this.food = { x: -1, y: -1 };
    this.food = this.freeCell() ?? { x: 0, y: 0 };
  }

  get tickMs(): number {
    return Math.max(55, 150 - (this.level - 1) * 12);
  }

  key(action: ArcadeAction, down: boolean): void {
    const next = DIRS[action];
    if (!down || !next || this.over) return;
    const last = this.pending.at(-1) ?? this.dir;
    // 不能原地掉头，也不重复入队同一方向
    if (last.x + next.x === 0 && last.y + next.y === 0) return;
    if (same(last, next)) return;
    if (this.pending.length < 2) this.pending.push(next);
  }

  step(dtMs: number): void {
    if (this.over) return;
    if (this.golden) {
      this.golden.msLeft -= dtMs;
      if (this.golden.msLeft <= 0) this.golden = null;
    }
    this.acc += dtMs;
    while (this.acc >= this.tickMs && !this.over) {
      this.acc -= this.tickMs;
      this.tick();
    }
  }

  tick(): void {
    this.dir = this.pending.shift() ?? this.dir;
    const head = this.body[0];
    const next = { x: head.x + this.dir.x, y: head.y + this.dir.y };
    const eating = same(next, this.food);
    const golden = this.golden;
    // 不吃东西时尾巴会在同一 tick 让出位置，所以撞尾巴格不算死
    const blockers = eating ? this.body : this.body.slice(0, -1);
    if (
      next.x < 0 || next.y < 0 || next.x >= SNAKE_COLS || next.y >= SNAKE_ROWS
      || blockers.some(p => same(p, next))
      || this.obstacles.some(p => same(p, next))
    ) {
      this.over = true;
      this.emit('lose');
      return;
    }
    this.body.unshift(next);
    if (golden && same(next, golden.at)) {
      // 金苹果不加长，只加分；剩余时间越多分越高
      this.score += Math.round(50 * this.level * (0.5 + golden.msLeft / GOLDEN_MS / 2));
      this.golden = null;
      this.emit('bonus');
    }
    if (!eating) {
      this.body.pop();
      return;
    }
    this.eaten += 1;
    this.score += 10 * this.level;
    this.emit('score');
    if (this.eaten % APPLES_PER_LEVEL === 0) this.levelUp();
    if (this.eaten % GOLDEN_EVERY === 0 && !this.golden) {
      const at = this.freeCell();
      if (at) this.golden = { at, msLeft: GOLDEN_MS };
    }
    const food = this.freeCell();
    if (!food) {
      this.over = true;
      return;
    }
    this.food = food;
  }

  private levelUp(): void {
    this.level += 1;
    this.emit('levelup');
    if (this.level < OBSTACLES_FROM_LEVEL) return;
    for (let i = 0; i < OBSTACLES_PER_LEVEL && this.obstacles.length < MAX_OBSTACLES; i++) {
      const cell = this.freeCell(true);
      if (cell) this.obstacles.push(cell);
    }
  }

  /** 随机空格子；`awayFromHead` 时避开蛇头 5 格以内，障碍不会贴脸生成。 */
  private freeCell(awayFromHead = false): Point | null {
    const head = this.body[0];
    const free: Point[] = [];
    for (let y = 0; y < SNAKE_ROWS; y++) {
      for (let x = 0; x < SNAKE_COLS; x++) {
        const p = { x, y };
        if (same(p, this.food) || (this.golden && same(p, this.golden.at))) continue;
        if (this.body.some(b => same(b, p)) || this.obstacles.some(o => same(o, p))) continue;
        if (awayFromHead && Math.abs(p.x - head.x) + Math.abs(p.y - head.y) < 5) continue;
        free.push(p);
      }
    }
    return pick(free, this.rng);
  }

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
    for (const o of this.obstacles) {
      ctx.fillStyle = c.muted;
      ctx.fillRect(o.x * CELL, o.y * CELL, CELL, CELL);
      ctx.fillStyle = c.line;
      ctx.fillRect(o.x * CELL + 2, o.y * CELL + 2, CELL - 4, CELL - 4);
    }
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(this.food.x * CELL + CELL / 2, this.food.y * CELL + CELL / 2, CELL / 2 - 1.5, 0, Math.PI * 2);
    ctx.fill();
    if (this.golden) {
      // 最后 2 秒闪烁提醒
      const blink = this.golden.msLeft < 2000 && Math.floor(this.golden.msLeft / 150) % 2 === 0;
      if (!blink) {
        const cx = this.golden.at.x * CELL + CELL / 2;
        const cy = this.golden.at.y * CELL + CELL / 2;
        ctx.fillStyle = '#e0a21b';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 5);
        ctx.lineTo(cx + 5, cy);
        ctx.lineTo(cx, cy + 5);
        ctx.lineTo(cx - 5, cy);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff6d0';
        ctx.fillRect(cx - 1, cy - 3, 2, 2);
      }
    }
    this.body.forEach((p, i) => {
      ctx.fillStyle = i === 0 ? c.ink : c.primary;
      ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
    });
  }
}
