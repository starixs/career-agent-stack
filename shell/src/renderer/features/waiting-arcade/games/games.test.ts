import { describe, expect, it } from 'vitest';

import { BreakoutGame } from './breakout';
import { keyToArcadeAction } from './index';
import { RunnerGame } from './runner';
import { SNAKE_COLS, SnakeGame } from './snake';

const fixedRng = (value: number) => () => value;

describe('SnakeGame', () => {
  it('moves one cell per tick and grows when it eats', () => {
    const game = new SnakeGame(fixedRng(0));
    const head = game.body[0];
    game.food = { x: head.x + 1, y: head.y };
    game.tick();
    expect(game.body[0]).toEqual({ x: head.x + 1, y: head.y });
    expect(game.body).toHaveLength(4);
    expect(game.score).toBe(1);
  });

  it('ignores reversing into itself but keeps two queued turns', () => {
    const game = new SnakeGame(fixedRng(0));
    game.food = { x: 0, y: 0 };
    game.key('left', true); // 直接掉头：忽略
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

  it('runs ticks from accumulated frame time', () => {
    const game = new SnakeGame(fixedRng(0));
    game.food = { x: 0, y: 0 };
    const x = game.body[0].x;
    game.step(game.tickMs * 2 + 1);
    expect(game.body[0].x).toBe(x + 2);
  });
});

describe('BreakoutGame', () => {
  it('keeps the ball docked until served, then breaks bricks for points', () => {
    const game = new BreakoutGame();
    game.step(500);
    expect(game.docked).toBe(true);
    game.key('action', true);
    expect(game.docked).toBe(false);
    for (let i = 0; i < 400 && game.score === 0; i++) game.step(16);
    expect(game.score).toBeGreaterThan(0);
    expect(game.bricks.some(b => !b.alive)).toBe(true);
  });

  it('loses a life when the ball drops and ends after the last one', () => {
    const game = new BreakoutGame();
    for (let life = 3; life > 0; life--) {
      game.key('action', true);
      game.ball = { x: 5, y: 300, vx: 0, vy: 0.1 };
      game.step(16);
    }
    expect(game.lives).toBe(0);
    expect(game.over).toBe(true);
  });

  it('moves the paddle while an arrow is held and clamps at the edge', () => {
    const game = new BreakoutGame();
    game.key('left', true);
    game.step(5000);
    expect(game.paddleX).toBe(0);
    game.key('left', false);
    game.step(100);
    expect(game.paddleX).toBe(0);
  });
});

describe('RunnerGame', () => {
  it('jumps only from the ground and lands again', () => {
    const game = new RunnerGame(fixedRng(0.5));
    const groundY = game.heroY;
    game.key('up', true);
    game.step(16);
    expect(game.heroY).toBeLessThan(groundY);
    const midAir = game.vy;
    game.key('up', true); // 空中二段跳：忽略
    expect(game.vy).toBe(midAir);
    for (let i = 0; i < 100; i++) game.step(16);
    expect(game.heroY).toBe(groundY);
  });

  it('scores by distance and crashes into an obstacle on the ground', () => {
    const game = new RunnerGame(fixedRng(0.5));
    game.step(20);
    expect(game.score).toBeGreaterThanOrEqual(0);
    game.obstacles = [{ x: 30, w: 18, h: 18 }];
    game.step(16);
    expect(game.over).toBe(true);
  });
});

describe('keyToArcadeAction', () => {
  it('maps arrows, WASD and space by physical key code', () => {
    expect(keyToArcadeAction('ArrowLeft')).toBe('left');
    expect(keyToArcadeAction('KeyW')).toBe('up');
    expect(keyToArcadeAction('Space')).toBe('action');
    expect(keyToArcadeAction('KeyQ')).toBeNull();
  });
});
