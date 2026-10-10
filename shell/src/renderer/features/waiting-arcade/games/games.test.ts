import { describe, expect, it } from 'vitest';

import { BreakoutGame, type Brick } from './breakout';
import { BIRD_LIFT, GROUND_Y, RunnerGame } from './runner';
import { GOLDEN_MS, SNAKE_COLS, SnakeGame } from './snake';

const fixedRng = (value: number) => () => value;

/** 把果子放到蛇头正前方再走一步。 */
function feed(game: SnakeGame) {
  const head = game.body[0];
  game.food = { x: head.x + 1, y: head.y };
  game.tick();
}

describe('SnakeGame', () => {
  it('moves one cell per tick and grows when it eats', () => {
    const game = new SnakeGame(fixedRng(0));
    const head = game.body[0];
    feed(game);
    expect(game.body[0]).toEqual({ x: head.x + 1, y: head.y });
    expect(game.body).toHaveLength(4);
    expect(game.score).toBe(10);
    expect(game.drainEvents()).toContain('score');
  });

  it('ignores reversing into itself but keeps two queued turns', () => {
    const game = new SnakeGame(fixedRng(0));
    game.food = { x: 0, y: 0 };
    game.key('left', true);
    game.key('up', true);
    game.key('left', true);
    const head = game.body[0];
    game.tick();
    expect(game.body[0]).toEqual({ x: head.x, y: head.y - 1 });
    game.tick();
    expect(game.body[0]).toEqual({ x: head.x - 1, y: head.y - 1 });
  });

  it('dies on the wall', () => {
    const game = new SnakeGame(fixedRng(0));
    game.food = { x: 0, y: 0 };
    for (let i = 0; i < SNAKE_COLS && !game.over; i++) game.tick();
    expect(game.over).toBe(true);
  });

  it('levels up every five apples, speeds up, and grows obstacles from level 3', () => {
    const game = new SnakeGame(fixedRng(0));
    const startTick = game.tickMs;
    for (let i = 0; i < 5; i++) feed(game);
    expect(game.level).toBe(2);
    expect(game.tickMs).toBeLessThan(startTick);
    expect(game.obstacles).toHaveLength(0);
    // 掉头往回走会撞自己，所以先拐下去再继续喂
    game.key('down', true);
    game.tick();
    for (let i = 0; i < 5; i++) {
      const head = game.body[0];
      game.food = { x: head.x, y: head.y + 1 };
      game.tick();
    }
    expect(game.level).toBe(3);
    expect(game.obstacles.length).toBe(3);
    const head = game.body[0];
    for (const o of game.obstacles) expect(Math.abs(o.x - head.x) + Math.abs(o.y - head.y)).toBeGreaterThanOrEqual(5);
    expect(game.drainEvents()).toContain('levelup');
  });

  it('spawns a timed golden apple worth a bonus', () => {
    const game = new SnakeGame(fixedRng(0.5));
    for (let i = 0; i < 4; i++) feed(game);
    expect(game.golden).not.toBeNull();
    const before = game.score;
    const head = game.body[0];
    game.golden!.at = { x: head.x + 1, y: head.y };
    game.food = { x: 0, y: 0 };
    game.tick();
    expect(game.golden).toBeNull();
    expect(game.score - before).toBeGreaterThanOrEqual(50);

    for (let i = 0; i < 4; i++) feed(game);
    expect(game.golden).not.toBeNull();
    game.step(GOLDEN_MS + 1);
    expect(game.golden).toBeNull();
  });
});

function brick(x: number, y: number, hp = 1, steel = false): Brick {
  return { x, y, hp: steel ? Infinity : hp, maxHp: steel ? Infinity : hp, steel };
}

describe('BreakoutGame', () => {
  it('keeps the ball docked until served, then breaks bricks for points', () => {
    const game = new BreakoutGame(fixedRng(0.99));
    game.step(500);
    expect(game.docked).toBe(true);
    game.key('a', true);
    expect(game.docked).toBe(false);
    for (let i = 0; i < 400 && game.score === 0; i++) game.step(16);
    expect(game.score).toBeGreaterThan(0);
    expect(game.bricks.some(b => b.hp <= 0)).toBe(true);
  });

  it('needs several hits for tough bricks and never breaks steel', () => {
    const game = new BreakoutGame(fixedRng(0.99));
    game.docked = false;
    game.bricks = [brick(100, 50, 2), brick(10, 20, 1, true), brick(200, 20)];
    game.ball = { x: 110, y: 59, vx: 0, vy: -0.1 };
    game.step(16);
    expect(game.bricks[0].hp).toBe(1);
    expect(game.score).toBe(5);

    game.ball = { x: 20, y: 29, vx: 0, vy: -0.1 };
    game.step(16);
    expect(game.bricks[1].hp).toBe(Infinity);
  });

  it('multiplies points for bricks broken in a row without touching the paddle', () => {
    const game = new BreakoutGame(fixedRng(0.99));
    game.docked = false;
    game.bricks = [brick(100, 50), brick(100, 80), brick(200, 20)];
    game.ball = { x: 110, y: 59, vx: 0, vy: -0.1 };
    game.step(16);
    expect(game.score).toBe(10);
    game.ball = { x: 110, y: 89, vx: 0, vy: -0.1 };
    game.step(16);
    expect(game.combo).toBe(2);
    expect(game.score).toBe(30);
  });

  it('applies a caught power-up', () => {
    const game = new BreakoutGame(fixedRng(0.99));
    game.docked = false;
    game.ball = { x: 50, y: 60, vx: 0, vy: -0.05 };
    game.capsules = [{ x: game.paddleX + 10, y: 147, kind: 'wide' }];
    game.step(16);
    expect(game.wideMs).toBeGreaterThan(0);
    expect(game.paddleW).toBeGreaterThan(40);

    game.capsules = [{ x: game.paddleX + 10, y: 147, kind: 'multi' }];
    game.step(16);
    expect(game.balls.length).toBe(3);
  });

  it('loses a life only when every ball is gone, and ends after the last one', () => {
    const game = new BreakoutGame(fixedRng(0.99));
    for (let life = 3; life > 0; life--) {
      game.key('a', true);
      game.ball = { x: 5, y: 300, vx: 0, vy: 0.1 };
      game.step(16);
    }
    expect(game.lives).toBe(0);
    expect(game.over).toBe(true);
  });

  it('advances to the next layout when every breakable brick is gone', () => {
    const game = new BreakoutGame(fixedRng(0.99));
    game.docked = false;
    game.bricks = [brick(100, 50), brick(10, 20, 1, true)];
    game.ball = { x: 110, y: 59, vx: 0, vy: -0.1 };
    game.step(16);
    expect(game.level).toBe(2);
    expect(game.docked).toBe(true);
    expect(game.bricks.some(b => b.maxHp === 2)).toBe(true);
  });

  it('moves the paddle while an arrow is held and clamps at the edge', () => {
    const game = new BreakoutGame();
    game.key('left', true);
    game.step(5000);
    expect(game.paddleX).toBe(0);
  });
});

describe('RunnerGame', () => {
  it('jumps higher while the button is held than on a quick tap', () => {
    const peak = (hold: boolean) => {
      const game = new RunnerGame(fixedRng(0.5));
      game.key('up', true);
      if (!hold) game.key('up', false);
      let top = game.heroY;
      for (let i = 0; i < 60; i++) {
        game.step(16);
        top = Math.min(top, game.heroY);
      }
      return GROUND_Y - top;
    };
    expect(peak(true)).toBeGreaterThan(peak(false) + 15);
  });

  it('ducks under a mid-height bird but not when standing', () => {
    const standing = new RunnerGame(fixedRng(0.5));
    standing.obstacles = [{ x: 30, w: 14, h: 8, kind: 'bird', lift: BIRD_LIFT.mid }];
    expect(standing.collides()).toBe(true);

    const ducking = new RunnerGame(fixedRng(0.5));
    ducking.key('down', true);
    ducking.obstacles = [{ x: 30, w: 14, h: 8, kind: 'bird', lift: BIRD_LIFT.mid }];
    expect(ducking.ducking).toBe(true);
    expect(ducking.collides()).toBe(false);
  });

  it('can stand under a high bird', () => {
    const game = new RunnerGame(fixedRng(0.5));
    game.obstacles = [{ x: 30, w: 14, h: 8, kind: 'bird', lift: BIRD_LIFT.high }];
    expect(game.collides()).toBe(false);
  });

  it('collects coins and crashes into a cactus', () => {
    const game = new RunnerGame(fixedRng(0.5));
    game.coins = [{ x: 34, y: GROUND_Y - 8 }];
    game.step(16);
    expect(game.coinScore).toBe(20);
    expect(game.drainEvents()).toContain('bonus');
    game.obstacles = [{ x: 30, w: 9, h: 19, kind: 'tall', lift: 0 }];
    game.step(16);
    expect(game.over).toBe(true);
  });

  it('levels up and speeds up with distance', () => {
    const game = new RunnerGame(fixedRng(0.5));
    const start = game.speed;
    game.distance = 1499;
    game.obstacles = [];
    game.step(30);
    expect(game.level).toBe(2);
    expect(game.speed).toBeGreaterThan(start);
  });
});
