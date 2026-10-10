// 打砖块：6 套关卡图案循环（循环一轮后砖更硬、球更快）；砖块 1~3 点耐久，
// 钢砖打不碎；不碰拍连续击砖有连击倍率；碎砖概率掉道具（加宽 / 多球 / 减速 / 加命）。

import {
  ARCADE_HEIGHT,
  ARCADE_WIDTH,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

const PADDLE_W = 40;
const WIDE_PADDLE_W = 60;
const PADDLE_H = 5;
const PADDLE_Y = ARCADE_HEIGHT - 12;
const PADDLE_SPEED = 0.24; // px / ms
const BALL_R = 3;
const BASE_BALL_SPEED = 0.13; // px / ms
const COLS = 9;
const BRICK_GAP = 2;
const BRICK_TOP = 18;
const BRICK_H = 7;
const BRICK_W = (ARCADE_WIDTH - BRICK_GAP * (COLS + 1)) / COLS;
const START_LIVES = 3;
const MAX_LIVES = 5;
const MAX_COMBO = 8;
const DROP_CHANCE = 0.14;
const CAPSULE_SPEED = 0.045;
const WIDE_MS = 12000;
const SLOW_MS = 8000;

/** '.' 空，'1'~'3' 耐久，'#' 钢砖。每行 9 格。 */
export const LEVELS: readonly string[][] = [
  ['111111111', '111111111', '111111111', '111111111'],
  ['....2....', '...212...', '..21112..', '.2111112.', '211111112'],
  ['2.2.2.2.2', '.1.1.1.1.', '2.2.2.2.2', '.1.1.1.1.', '#.......#'],
  ['333333333', '2#22222#2', '111111111', '1#11111#1'],
  ['.22...22.', '2112.2112', '211121112', '.2111112.', '..21112..', '...232...'],
  ['#3#3#3#3#', '212121212', '3.3.3.3.3', '111111111', '.#.#.#.#.'],
];

export type PowerKind = 'wide' | 'multi' | 'slow' | 'life';

export interface Brick { x: number; y: number; hp: number; maxHp: number; steel: boolean }
export interface Ball { x: number; y: number; vx: number; vy: number }
export interface Capsule { x: number; y: number; kind: PowerKind }

export class BreakoutGame extends EventfulGame implements ArcadeGame {
  score = 0;
  over = false;
  lives = START_LIVES;
  level = 1;
  paddleX = (ARCADE_WIDTH - PADDLE_W) / 2;
  balls: Ball[] = [];
  /** 球停在拍子上等待发球。 */
  docked = true;
  bricks: Brick[] = [];
  capsules: Capsule[] = [];
  combo = 0;
  wideMs = 0;
  slowMs = 0;
  private nextLifeAt = 2000;
  private held = { left: false, right: false };

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  /** 兼容单球场景的便捷访问。 */
  get ball(): Ball {
    return this.balls[0];
  }

  set ball(ball: Ball) {
    this.balls = [ball];
  }

  get paddleW(): number {
    return this.wideMs > 0 ? WIDE_PADDLE_W : PADDLE_W;
  }

  get baseSpeed(): number {
    return Math.min(0.22, BASE_BALL_SPEED * (1 + (this.level - 1) * 0.08));
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.lives = START_LIVES;
    this.level = 1;
    this.nextLifeAt = 2000;
    this.paddleX = (ARCADE_WIDTH - PADDLE_W) / 2;
    this.held = { left: false, right: false };
    this.buildBricks();
    this.dock();
  }

  private buildBricks(): void {
    const pattern = LEVELS[(this.level - 1) % LEVELS.length];
    const toughness = Math.floor((this.level - 1) / LEVELS.length);
    this.bricks = [];
    pattern.forEach((row, r) => {
      [...row].forEach((ch, col) => {
        if (ch === '.') return;
        const steel = ch === '#';
        const hp = steel ? Infinity : Math.min(3, Number(ch) + toughness);
        this.bricks.push({
          x: BRICK_GAP + col * (BRICK_W + BRICK_GAP),
          y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
          hp,
          maxHp: hp,
          steel,
        });
      });
    });
  }

  private dock(): void {
    this.docked = true;
    this.combo = 0;
    this.capsules = [];
    this.wideMs = 0;
    this.slowMs = 0;
    this.balls = [{ x: this.paddleX + this.paddleW / 2, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0 }];
  }

  private launch(): void {
    const speed = this.baseSpeed;
    this.docked = false;
    const angle = (this.rng() - 0.5) * 0.8; // 发球角度略有随机
    this.balls[0].vx = speed * Math.sin(angle + 0.35);
    this.balls[0].vy = -speed * Math.cos(angle + 0.35);
  }

  key(action: ArcadeAction, down: boolean): void {
    if (action === 'left') this.held.left = down;
    if (action === 'right') this.held.right = down;
    const serve = action === 'a' || action === 'b' || action === 'up';
    if (serve && down && this.docked && !this.over) this.launch();
  }

  step(dtMs: number): void {
    if (this.over) return;
    const dir = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
    this.paddleX = Math.min(ARCADE_WIDTH - this.paddleW, Math.max(0, this.paddleX + dir * PADDLE_SPEED * dtMs));
    if (this.docked) {
      this.balls[0].x = this.paddleX + this.paddleW / 2;
      return;
    }
    this.wideMs = Math.max(0, this.wideMs - dtMs);
    this.slowMs = Math.max(0, this.slowMs - dtMs);
    this.moveCapsules(dtMs);
    const ballDt = this.slowMs > 0 ? dtMs * 0.65 : dtMs;
    // 分小步推进，防止高速时穿过砖块
    const steps = Math.max(1, Math.ceil(ballDt / 4));
    for (let i = 0; i < steps && !this.docked && !this.over; i++) this.advance(ballDt / steps);
  }

  private moveCapsules(dtMs: number): void {
    const keep: Capsule[] = [];
    for (const cap of this.capsules) {
      cap.y += CAPSULE_SPEED * dtMs;
      const caught = cap.y + 4 >= PADDLE_Y && cap.y - 4 <= PADDLE_Y + PADDLE_H
        && cap.x + 7 >= this.paddleX && cap.x - 7 <= this.paddleX + this.paddleW;
      if (caught) this.applyPower(cap.kind);
      else if (cap.y < ARCADE_HEIGHT + 6) keep.push(cap);
    }
    this.capsules = keep;
  }

  private applyPower(kind: PowerKind): void {
    this.emit('bonus');
    this.score += 50;
    if (kind === 'wide') this.wideMs = WIDE_MS;
    if (kind === 'slow') this.slowMs = SLOW_MS;
    if (kind === 'life') this.lives = Math.min(MAX_LIVES, this.lives + 1);
    if (kind === 'multi') {
      const src = this.balls[0];
      if (!src) return;
      const speed = Math.hypot(src.vx, src.vy) || this.baseSpeed;
      for (const a of [-0.6, 0.6]) {
        this.balls.push({ x: src.x, y: src.y, vx: speed * Math.sin(a), vy: -speed * Math.cos(a) });
      }
    }
  }

  private advance(dt: number): void {
    for (const b of this.balls) this.moveBall(b, dt);
    this.balls = this.balls.filter(b => b.y - BALL_R <= ARCADE_HEIGHT);

    if (this.bricks.every(br => br.steel || br.hp <= 0)) {
      this.score += 100 * this.level;
      this.level += 1;
      this.emit('levelup');
      this.buildBricks();
      this.dock();
      return;
    }
    if (this.balls.length === 0) {
      this.lives -= 1;
      this.emit('lose');
      if (this.lives <= 0) this.over = true;
      else this.dock();
    }
  }

  private moveBall(b: Ball, dt: number): void {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    if (b.x > ARCADE_WIDTH - BALL_R) { b.x = ARCADE_WIDTH - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

    const pw = this.paddleW;
    if (
      b.vy > 0
      && b.y + BALL_R >= PADDLE_Y && b.y - BALL_R <= PADDLE_Y + PADDLE_H
      && b.x >= this.paddleX - BALL_R && b.x <= this.paddleX + pw + BALL_R
    ) {
      // 击中位置决定反弹角度：拍子边缘打出更斜的球
      const speed = Math.hypot(b.vx, b.vy);
      const hit = ((b.x - this.paddleX) / pw) * 2 - 1;
      const angle = Math.max(-1, Math.min(1, hit)) * (Math.PI / 3);
      b.vx = speed * Math.sin(angle);
      b.vy = -speed * Math.cos(angle);
      b.y = PADDLE_Y - BALL_R;
      this.combo = 0;
      this.emit('hit');
    }

    for (const brick of this.bricks) {
      if (brick.hp <= 0) continue;
      if (b.x + BALL_R < brick.x || b.x - BALL_R > brick.x + BRICK_W) continue;
      if (b.y + BALL_R < brick.y || b.y - BALL_R > brick.y + BRICK_H) continue;
      const overlapX = Math.min(b.x + BALL_R - brick.x, brick.x + BRICK_W - (b.x - BALL_R));
      const overlapY = Math.min(b.y + BALL_R - brick.y, brick.y + BRICK_H - (b.y - BALL_R));
      // 反弹后把球推出砖外，否则下一小步仍重叠会被算成第二次击中
      if (overlapX < overlapY) {
        b.vx = -b.vx;
        b.x = b.vx > 0 ? brick.x + BRICK_W + BALL_R : brick.x - BALL_R;
      } else {
        b.vy = -b.vy;
        b.y = b.vy > 0 ? brick.y + BRICK_H + BALL_R : brick.y - BALL_R;
      }
      this.hitBrick(brick, b);
      break;
    }
  }

  private hitBrick(brick: Brick, ball: Ball): void {
    if (brick.steel) {
      this.emit('tick');
      return;
    }
    brick.hp -= 1;
    // 每次击砖球微微提速，上限为本关基础速度的 1.5 倍
    const speed = Math.hypot(ball.vx, ball.vy);
    const target = Math.min(speed * 1.012, this.baseSpeed * 1.5);
    ball.vx *= target / speed;
    ball.vy *= target / speed;
    if (brick.hp > 0) {
      this.score += 5;
      this.emit('hit');
      return;
    }
    this.combo = Math.min(MAX_COMBO, this.combo + 1);
    this.score += 10 * brick.maxHp * this.combo;
    this.emit('score');
    if (this.score >= this.nextLifeAt) {
      this.nextLifeAt += 2000;
      this.lives = Math.min(MAX_LIVES, this.lives + 1);
      this.emit('bonus');
    }
    if (this.rng() < DROP_CHANCE) {
      const roll = this.rng();
      const kind: PowerKind = roll < 0.1 ? 'life' : roll < 0.4 ? 'multi' : roll < 0.7 ? 'wide' : 'slow';
      this.capsules.push({ x: brick.x + BRICK_W / 2, y: brick.y + BRICK_H / 2, kind });
    }
  }

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
    const hpColors = [c.primary, c.accent, c.danger];
    for (const brick of this.bricks) {
      if (brick.hp <= 0) continue;
      if (brick.steel) {
        ctx.fillStyle = c.muted;
        ctx.fillRect(brick.x, brick.y, BRICK_W, BRICK_H);
        ctx.fillStyle = c.line;
        ctx.fillRect(brick.x + 2, brick.y + 1, BRICK_W - 4, 1);
        continue;
      }
      ctx.fillStyle = hpColors[Math.min(3, brick.hp) - 1];
      ctx.fillRect(brick.x, brick.y, BRICK_W, BRICK_H);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(brick.x, brick.y, BRICK_W, 1);
      // 已经被打过的砖画一道裂纹
      if (brick.hp < brick.maxHp) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(brick.x + BRICK_W / 2 - 1, brick.y + 1, 1, BRICK_H - 2);
        ctx.fillRect(brick.x + BRICK_W / 2, brick.y + 3, 3, 1);
      }
    }
    ctx.font = '700 7px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labels: Record<PowerKind, string> = { wide: 'W', multi: 'M', slow: 'S', life: '+' };
    for (const cap of this.capsules) {
      ctx.fillStyle = cap.kind === 'life' ? c.danger : c.ink;
      ctx.fillRect(cap.x - 7, cap.y - 4, 14, 8);
      ctx.fillStyle = c.bg;
      ctx.fillText(labels[cap.kind], cap.x, cap.y + 0.5);
    }
    ctx.fillStyle = this.wideMs > 0 ? c.primary : c.ink;
    ctx.fillRect(this.paddleX, PADDLE_Y, this.paddleW, PADDLE_H);
    ctx.fillStyle = c.ink;
    for (const b of this.balls) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.combo >= 2) {
      ctx.fillStyle = c.accent;
      ctx.font = '700 8px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`x${this.combo}`, 4, ARCADE_HEIGHT - 20);
    }
  }
}
