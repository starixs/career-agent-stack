import { ARCADE_HEIGHT, ARCADE_WIDTH, type ArcadeAction, type ArcadeGame, type ArcadePalette, type Rng } from './types';

const CELL = 12;
export const SNAKE_COLS = ARCADE_WIDTH / CELL; // 24
export const SNAKE_ROWS = ARCADE_HEIGHT / CELL; // 16
const START_TICK_MS = 140;
const MIN_TICK_MS = 70;

interface Point { x: number; y: number }

const DIRS: Partial<Record<ArcadeAction, Point>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export class SnakeGame implements ArcadeGame {
  score = 0;
  over = false;
  body: Point[] = [];
  food: Point = { x: 0, y: 0 };
  private dir: Point = { x: 1, y: 0 };
  /** 一个 tick 内连按两次方向键（如 上→左）都要生效，否则急转会被吞掉。 */
  private pending: Point[] = [];
  private acc = 0;

  constructor(private readonly rng: Rng = Math.random) {
    this.reset();
  }

  reset(): void {
    const y = Math.floor(SNAKE_ROWS / 2);
    this.body = [{ x: 6, y }, { x: 5, y }, { x: 4, y }];
    this.dir = { x: 1, y: 0 };
    this.pending = [];
    this.acc = 0;
    this.score = 0;
    this.over = false;
    this.placeFood();
  }

  get tickMs(): number {
    return Math.max(MIN_TICK_MS, START_TICK_MS - this.score * 3);
  }

  key(action: ArcadeAction, down: boolean): void {
    const next = DIRS[action];
    if (!down || !next || this.over) return;
    const last = this.pending.at(-1) ?? this.dir;
    // 不能原地掉头，也不重复入队同一方向
    if (last.x + next.x === 0 && last.y + next.y === 0) return;
    if (last.x === next.x && last.y === next.y) return;
    if (this.pending.length < 2) this.pending.push(next);
  }

  step(dtMs: number): void {
    if (this.over) return;
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
    const eating = next.x === this.food.x && next.y === this.food.y;
    // 不吃东西时尾巴会在同一 tick 让出位置，所以撞尾巴格不算死
    const blockers = eating ? this.body : this.body.slice(0, -1);
    if (
      next.x < 0 || next.y < 0 || next.x >= SNAKE_COLS || next.y >= SNAKE_ROWS
      || blockers.some(p => p.x === next.x && p.y === next.y)
    ) {
      this.over = true;
      return;
    }
    this.body.unshift(next);
    if (eating) {
      this.score += 1;
      this.placeFood();
    } else {
      this.body.pop();
    }
  }

  private placeFood(): void {
    const free: Point[] = [];
    for (let y = 0; y < SNAKE_ROWS; y++) {
      for (let x = 0; x < SNAKE_COLS; x++) {
        if (!this.body.some(p => p.x === x && p.y === y)) free.push({ x, y });
      }
    }
    if (free.length === 0) {
      this.over = true;
      return;
    }
    this.food = free[Math.floor(this.rng() * free.length)];
  }

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(this.food.x * CELL + CELL / 2, this.food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    this.body.forEach((p, i) => {
      ctx.fillStyle = i === 0 ? c.ink : c.primary;
      ctx.fillRect(p.x * CELL + 1, p.y * CELL + 1, CELL - 2, CELL - 2);
    });
  }
}
