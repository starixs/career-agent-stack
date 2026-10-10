// 跳跳小人：按住跳得更高、轻点小跳；↓ 在地面蹲下、空中快速下落。
// 地面有三种仙人掌，250 分后出现三种高度的飞鸟（低的要跳、中的要蹲、高的别跳），
// 路上散落金币；每 1500 距离升一级加速。

import {
  ARCADE_HEIGHT,
  ARCADE_WIDTH,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

export const GROUND_Y = ARCADE_HEIGHT - 24;
const HERO_X = 28;
const HERO_W = 12;
const HERO_H = 16;
const DUCK_W = 15;
const DUCK_H = 9;
const JUMP_V = -0.36; // px / ms
const GRAVITY_HOLD = 0.001; // 按住跳跃键上升时
const GRAVITY = 0.002;
const START_SPEED = 0.1; // px / ms
const MAX_SPEED = 0.3;
const LEVEL_DISTANCE = 1500;
const BIRDS_FROM_SCORE = 250;
const COIN_SCORE = 20;

export type ObstacleKind = 'cactus' | 'tall' | 'double' | 'bird';
/** 鸟的高度：bottom 离地面的距离。 */
export const BIRD_LIFT = { low: 2, mid: 10, high: 30 } as const;

export interface Obstacle { x: number; w: number; h: number; kind: ObstacleKind; lift: number }
export interface Coin { x: number; y: number }

export class RunnerGame extends EventfulGame implements ArcadeGame {
  score = 0;
  over = false;
  level = 1;
  heroY = GROUND_Y - HERO_H;
  vy = 0;
  speed = START_SPEED;
  distance = 0;
  coinScore = 0;
  obstacles: Obstacle[] = [];
  coins: Coin[] = [];
  ducking = false;
  private jumpHeld = false;
  private downHeld = false;
  private nextSpawn = 0;
  private nextCoins = 0;
  private flap = 0;

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.level = 1;
    this.heroY = GROUND_Y - HERO_H;
    this.vy = 0;
    this.speed = START_SPEED;
    this.distance = 0;
    this.coinScore = 0;
    this.obstacles = [];
    this.coins = [];
    this.ducking = false;
    this.jumpHeld = false;
    this.downHeld = false;
    this.nextSpawn = ARCADE_WIDTH;
    this.nextCoins = ARCADE_WIDTH * 1.5;
  }

  get onGround(): boolean {
    return this.heroY >= GROUND_Y - this.heroH;
  }

  get heroH(): number {
    return this.ducking ? DUCK_H : HERO_H;
  }

  get heroW(): number {
    return this.ducking ? DUCK_W : HERO_W;
  }

  key(action: ArcadeAction, down: boolean): void {
    if (this.over) return;
    if (action === 'up' || action === 'a' || action === 'b') {
      this.jumpHeld = down;
      if (down && this.onGround) {
        this.ducking = false;
        this.heroY = GROUND_Y - HERO_H;
        this.vy = JUMP_V;
        this.emit('tick');
      }
    }
    if (action === 'down') {
      this.downHeld = down;
      if (this.onGround) this.setDuck(down);
    }
  }

  private setDuck(duck: boolean): void {
    if (this.ducking === duck) return;
    this.ducking = duck;
    this.heroY = GROUND_Y - this.heroH;
  }

  step(dtMs: number): void {
    if (this.over) return;
    this.flap += dtMs;
    const rising = this.vy < 0;
    let g = rising && this.jumpHeld ? GRAVITY_HOLD : GRAVITY;
    if (this.downHeld && !this.onGround) g *= 3; // 空中按 ↓ 快速下落
    this.vy += g * dtMs;
    this.heroY = Math.min(GROUND_Y - this.heroH, this.heroY + this.vy * dtMs);
    if (this.onGround) {
      this.vy = 0;
      this.setDuck(this.downHeld);
    }

    const dx = this.speed * dtMs;
    const before = Math.floor(this.distance / 10);
    this.distance += dx;
    const runScore = Math.floor(this.distance / 10);
    if (Math.floor(runScore / 100) > Math.floor(before / 100)) this.emit('score');
    this.score = runScore + this.coinScore;
    const level = 1 + Math.floor(this.distance / LEVEL_DISTANCE);
    if (level > this.level) {
      this.level = level;
      this.emit('levelup');
    }
    this.speed = Math.min(MAX_SPEED, START_SPEED + (this.level - 1) * 0.022 + (this.distance % LEVEL_DISTANCE) / 200000);

    for (const o of this.obstacles) o.x -= o.kind === 'bird' ? dx * 1.15 : dx;
    this.obstacles = this.obstacles.filter(o => o.x + o.w > -4);
    for (const coin of this.coins) coin.x -= dx;
    this.coins = this.coins.filter(coin => coin.x > -6);

    this.nextSpawn -= dx;
    if (this.nextSpawn <= 0) this.spawnObstacle();
    this.nextCoins -= dx;
    if (this.nextCoins <= 0) this.spawnCoins();

    this.collectCoins();
    if (this.collides()) {
      this.over = true;
      this.emit('lose');
    }
  }

  private spawnObstacle(): void {
    const birdsUnlocked = this.score >= BIRDS_FROM_SCORE;
    const roll = this.rng();
    let o: Obstacle;
    if (birdsUnlocked && roll < 0.3) {
      const heights = [BIRD_LIFT.low, BIRD_LIFT.mid, BIRD_LIFT.high];
      const lift = heights[Math.floor(this.rng() * heights.length)];
      o = { x: ARCADE_WIDTH, w: 14, h: 8, kind: 'bird', lift };
    } else if (roll < 0.55) {
      o = { x: ARCADE_WIDTH, w: 8, h: 12, kind: 'cactus', lift: 0 };
    } else if (roll < 0.8) {
      o = { x: ARCADE_WIDTH, w: 9, h: 19, kind: 'tall', lift: 0 };
    } else {
      o = { x: ARCADE_WIDTH, w: 19, h: 13, kind: 'double', lift: 0 };
    }
    this.obstacles.push(o);
    // 间距随速度放大，保证永远跳得过去；越往后随机幅度越小、越紧凑
    this.nextSpawn = this.speed * 620 + this.rng() * this.speed * (900 - Math.min(400, this.level * 40));
  }

  private spawnCoins(): void {
    const high = this.rng() < 0.5;
    const y = high ? GROUND_Y - 34 : GROUND_Y - 8;
    const count = 3 + Math.floor(this.rng() * 3);
    for (let i = 0; i < count; i++) this.coins.push({ x: ARCADE_WIDTH + 8 + i * 12, y });
    this.nextCoins = 400 + this.rng() * 500;
  }

  private heroBox() {
    return { x: HERO_X + 2, y: this.heroY + 2, w: this.heroW - 4, h: this.heroH - 4 };
  }

  private collectCoins(): void {
    const h = this.heroBox();
    const before = this.coins.length;
    this.coins = this.coins.filter(coin =>
      !(coin.x + 3 > h.x && coin.x - 3 < h.x + h.w && coin.y + 3 > h.y && coin.y - 3 < h.y + h.h));
    const got = before - this.coins.length;
    if (got > 0) {
      this.coinScore += got * COIN_SCORE;
      this.score += got * COIN_SCORE;
      this.emit('bonus');
    }
  }

  collides(): boolean {
    const h = this.heroBox();
    return this.obstacles.some(o => {
      const top = GROUND_Y - o.lift - o.h;
      const bottom = GROUND_Y - o.lift;
      return h.x + h.w > o.x + 1 && h.x < o.x + o.w - 1 && h.y + h.h > top + 1 && h.y < bottom - 1;
    });
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
    for (let x = -((this.distance * 0.5) % 37); x < ARCADE_WIDTH; x += 37) ctx.fillRect(x + 11, GROUND_Y + 12, 3, 1);

    ctx.fillStyle = '#e0a21b';
    for (const coin of this.coins) {
      ctx.beginPath();
      ctx.arc(coin.x, coin.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const o of this.obstacles) {
      const top = GROUND_Y - o.lift - o.h;
      if (o.kind === 'bird') {
        const wingUp = Math.floor(this.flap / 160) % 2 === 0;
        ctx.fillStyle = c.ink;
        ctx.fillRect(o.x + 3, top + 3, 9, 3);
        ctx.fillRect(o.x, top + 3, 3, 2);
        ctx.fillRect(o.x + 5, wingUp ? top : top + 6, 4, 2);
        continue;
      }
      ctx.fillStyle = c.danger;
      if (o.kind === 'double') {
        ctx.fillRect(o.x, top + 3, 8, o.h - 3);
        ctx.fillRect(o.x + 11, top, 8, o.h);
      } else {
        ctx.fillRect(o.x + 2, top, o.w - 4, o.h);
        ctx.fillRect(o.x, top + 4, 2, 5);
        ctx.fillRect(o.x + o.w - 2, top + 3, 2, 5);
      }
    }

    ctx.fillStyle = c.primary;
    ctx.fillRect(HERO_X, this.heroY, this.heroW, this.heroH);
    ctx.fillStyle = c.bg;
    ctx.fillRect(HERO_X + this.heroW - 5, this.heroY + 3, 3, 3);
    if (this.onGround && !this.ducking) {
      // 跑动时两条腿交替
      const stride = Math.floor(this.distance / 8) % 2;
      ctx.fillStyle = c.ink;
      ctx.fillRect(HERO_X + (stride ? 2 : 7), GROUND_Y - 2, 3, 2);
    }
  }
}
