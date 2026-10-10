import { ARCADE_HEIGHT, ARCADE_WIDTH, type ArcadeAction, type ArcadeGame, type ArcadePalette, type Rng } from './types';

const GROUND_Y = ARCADE_HEIGHT - 28;
const HERO_X = 32;
const HERO_W = 14;
const HERO_H = 20;
const GRAVITY = 0.0016; // px / ms²
const JUMP_V = -0.5; // px / ms
const START_SPEED = 0.12; // px / ms
const MAX_SPEED = 0.32;
const MIN_GAP = 110;

export interface Obstacle { x: number; w: number; h: number }

/** 横版跳跃：躲开地上的方块，跑得越久越快。 */
export class RunnerGame implements ArcadeGame {
  score = 0;
  over = false;
  heroY = GROUND_Y - HERO_H;
  vy = 0;
  speed = START_SPEED;
  distance = 0;
  obstacles: Obstacle[] = [];
  private nextSpawn = 0;

  constructor(private readonly rng: Rng = Math.random) {
    this.reset();
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.heroY = GROUND_Y - HERO_H;
    this.vy = 0;
    this.speed = START_SPEED;
    this.distance = 0;
    this.obstacles = [];
    this.nextSpawn = ARCADE_WIDTH;
  }

  get onGround(): boolean {
    return this.heroY >= GROUND_Y - HERO_H;
  }

  key(action: ArcadeAction, down: boolean): void {
    if (!down || this.over) return;
    if ((action === 'up' || action === 'action') && this.onGround) this.vy = JUMP_V;
  }

  step(dtMs: number): void {
    if (this.over) return;
    this.vy += GRAVITY * dtMs;
    this.heroY = Math.min(GROUND_Y - HERO_H, this.heroY + this.vy * dtMs);
    if (this.onGround) this.vy = 0;

    const dx = this.speed * dtMs;
    this.distance += dx;
    this.score = Math.floor(this.distance / 10);
    this.speed = Math.min(MAX_SPEED, START_SPEED + this.distance / 60000);

    for (const o of this.obstacles) o.x -= dx;
    this.obstacles = this.obstacles.filter(o => o.x + o.w > 0);

    this.nextSpawn -= dx;
    if (this.nextSpawn <= 0) {
      const h = 12 + Math.floor(this.rng() * 3) * 6;
      const w = 10 + Math.floor(this.rng() * 2) * 8;
      this.obstacles.push({ x: ARCADE_WIDTH, w, h });
      this.nextSpawn = MIN_GAP + this.rng() * 120 + this.speed * 200;
    }

    const heroBottom = this.heroY + HERO_H;
    for (const o of this.obstacles) {
      // 碰撞盒各缩 2px，擦边不判死，手感更宽容
      if (
        HERO_X + HERO_W - 2 > o.x + 2 && HERO_X + 2 < o.x + o.w - 2
        && heroBottom - 2 > GROUND_Y - o.h
      ) {
        this.over = true;
        return;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
    ctx.fillStyle = c.line;
    ctx.fillRect(0, GROUND_Y, ARCADE_WIDTH, 1);
    // 地面纹理随距离滚动，提供速度感
    ctx.fillStyle = c.muted;
    const offset = this.distance % 24;
    for (let x = -offset; x < ARCADE_WIDTH; x += 24) ctx.fillRect(x, GROUND_Y + 6, 6, 1);
    ctx.fillStyle = c.danger;
    for (const o of this.obstacles) ctx.fillRect(o.x, GROUND_Y - o.h, o.w, o.h);
    ctx.fillStyle = c.primary;
    ctx.fillRect(HERO_X, this.heroY, HERO_W, HERO_H);
    ctx.fillStyle = c.bg;
    ctx.fillRect(HERO_X + 8, this.heroY + 4, 3, 3);
  }
}
