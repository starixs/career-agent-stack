import { ARCADE_HEIGHT, ARCADE_WIDTH, type ArcadeAction, type ArcadeGame, type ArcadePalette } from './types';

const PADDLE_W = 48;
const PADDLE_H = 6;
const PADDLE_Y = ARCADE_HEIGHT - 14;
const PADDLE_SPEED = 0.28; // px / ms
const BALL_R = 4;
const BASE_BALL_SPEED = 0.16; // px / ms
const COLS = 9;
const ROWS = 4;
const BRICK_GAP = 3;
const BRICK_TOP = 22;
const BRICK_H = 9;
const BRICK_W = (ARCADE_WIDTH - BRICK_GAP * (COLS + 1)) / COLS;
const START_LIVES = 3;

export interface Brick { x: number; y: number; row: number; alive: boolean }

export class BreakoutGame implements ArcadeGame {
  score = 0;
  over = false;
  lives = START_LIVES;
  level = 1;
  paddleX = (ARCADE_WIDTH - PADDLE_W) / 2;
  ball = { x: 0, y: 0, vx: 0, vy: 0 };
  /** 球停在拍子上等待发球。 */
  docked = true;
  bricks: Brick[] = [];
  private held = { left: false, right: false };

  constructor() {
    this.reset();
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.lives = START_LIVES;
    this.level = 1;
    this.paddleX = (ARCADE_WIDTH - PADDLE_W) / 2;
    this.held = { left: false, right: false };
    this.buildBricks();
    this.dock();
  }

  private buildBricks(): void {
    this.bricks = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        this.bricks.push({
          x: BRICK_GAP + col * (BRICK_W + BRICK_GAP),
          y: BRICK_TOP + row * (BRICK_H + BRICK_GAP),
          row,
          alive: true,
        });
      }
    }
  }

  private dock(): void {
    this.docked = true;
    this.ball = { x: this.paddleX + PADDLE_W / 2, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0 };
  }

  private launch(): void {
    const speed = BASE_BALL_SPEED * (1 + (this.level - 1) * 0.15);
    this.docked = false;
    this.ball.vx = speed * 0.6;
    this.ball.vy = -speed * 0.8;
  }

  key(action: ArcadeAction, down: boolean): void {
    if (action === 'left') this.held.left = down;
    if (action === 'right') this.held.right = down;
    if ((action === 'action' || action === 'up') && down && this.docked && !this.over) this.launch();
  }

  step(dtMs: number): void {
    if (this.over) return;
    const dir = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
    this.paddleX = Math.min(ARCADE_WIDTH - PADDLE_W, Math.max(0, this.paddleX + dir * PADDLE_SPEED * dtMs));
    if (this.docked) {
      this.ball.x = this.paddleX + PADDLE_W / 2;
      return;
    }
    // 分小步推进，防止高速时穿过砖块
    const steps = Math.max(1, Math.ceil(dtMs / 4));
    for (let i = 0; i < steps && !this.docked && !this.over; i++) this.advance(dtMs / steps);
  }

  private advance(dt: number): void {
    const b = this.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    if (b.x > ARCADE_WIDTH - BALL_R) { b.x = ARCADE_WIDTH - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

    if (
      b.vy > 0
      && b.y + BALL_R >= PADDLE_Y && b.y - BALL_R <= PADDLE_Y + PADDLE_H
      && b.x >= this.paddleX - BALL_R && b.x <= this.paddleX + PADDLE_W + BALL_R
    ) {
      // 击中位置决定反弹角度：拍子边缘打出更斜的球
      const speed = Math.hypot(b.vx, b.vy);
      const hit = ((b.x - this.paddleX) / PADDLE_W) * 2 - 1;
      const angle = Math.max(-1, Math.min(1, hit)) * (Math.PI / 3);
      b.vx = speed * Math.sin(angle);
      b.vy = -speed * Math.cos(angle);
      b.y = PADDLE_Y - BALL_R;
    }

    for (const brick of this.bricks) {
      if (!brick.alive) continue;
      if (b.x + BALL_R < brick.x || b.x - BALL_R > brick.x + BRICK_W) continue;
      if (b.y + BALL_R < brick.y || b.y - BALL_R > brick.y + BRICK_H) continue;
      brick.alive = false;
      this.score += (ROWS - brick.row) * 10;
      const overlapX = Math.min(b.x + BALL_R - brick.x, brick.x + BRICK_W - (b.x - BALL_R));
      const overlapY = Math.min(b.y + BALL_R - brick.y, brick.y + BRICK_H - (b.y - BALL_R));
      if (overlapX < overlapY) b.vx = -b.vx;
      else b.vy = -b.vy;
      break;
    }

    if (this.bricks.every(br => !br.alive)) {
      this.level += 1;
      this.buildBricks();
      this.dock();
      return;
    }

    if (b.y - BALL_R > ARCADE_HEIGHT) {
      this.lives -= 1;
      if (this.lives <= 0) this.over = true;
      else this.dock();
    }
  }

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
    const rowColors = [c.danger, c.accent, c.primary, c.muted];
    for (const brick of this.bricks) {
      if (!brick.alive) continue;
      ctx.fillStyle = rowColors[brick.row % rowColors.length];
      ctx.fillRect(brick.x, brick.y, BRICK_W, BRICK_H);
    }
    ctx.fillStyle = c.ink;
    ctx.fillRect(this.paddleX, PADDLE_Y, PADDLE_W, PADDLE_H);
    ctx.beginPath();
    ctx.arc(this.ball.x, this.ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.muted;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText('♥'.repeat(Math.max(0, this.lives)), 4, 6);
    ctx.textAlign = 'right';
    ctx.fillText(`L${this.level}`, ARCADE_WIDTH - 4, 6);
    ctx.textAlign = 'left';
  }
}
