import { describe, expect, it } from 'vitest';

import { COLS, KINDS, ROWS, TetrisGame, gravityMs, type PieceKind } from './tetris';

const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

/** 把底部 rows 行填满，只在 holes 里的列留空。 */
function fillRows(game: TetrisGame, rows: number, holes: number[]) {
  for (let y = ROWS - rows; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) game.board[y][x] = holes.includes(x) ? null : 'Z';
  }
}

function place(game: TetrisGame, kind: PieceKind, rot: number, x: number, y = 0) {
  game.active = { kind, rot, x, y };
}

describe('TetrisGame', () => {
  it('deals pieces from a shuffled 7-bag', () => {
    const game = new TetrisGame(seq([0.3, 0.7, 0.1, 0.9, 0.5]));
    const dealt: PieceKind[] = [];
    for (let i = 0; i < 7; i++) {
      dealt.push(game.active!.kind);
      game.hardDrop();
    }
    expect(new Set(dealt)).toEqual(new Set(KINDS));
  });

  it('hard-drops to the floor for two points a row and spawns the next piece', () => {
    const game = new TetrisGame();
    place(game, 'O', 0, 4, 0);
    const next = game.queue[0];
    game.key('up', true);
    expect(game.board[ROWS - 1][4]).toBe('O');
    expect(game.board[ROWS - 2][5]).toBe('O');
    expect(game.score).toBe((ROWS - 2) * 2);
    expect(game.active?.kind).toBe(next);
  });

  it('kicks a rotation off the wall instead of refusing it', () => {
    const game = new TetrisGame();
    place(game, 'I', 1, -2, 5); // 竖条贴左墙
    expect(game.fits(game.active!)).toBe(true);
    expect(game.rotate(1)).toBe(true);
    expect(game.fits(game.active!)).toBe(true);
    expect(game.active!.rot).toBe(2);
  });

  it('flashes then clears a full line for 100 × level', () => {
    const game = new TetrisGame();
    fillRows(game, 1, [3, 4, 5, 6]);
    place(game, 'I', 0, 3, 0);
    game.key('up', true);
    expect(game.clearing?.rows).toEqual([ROWS - 1]);
    const dropPoints = game.score - 100;
    expect(dropPoints).toBeGreaterThan(0);
    game.step(300);
    expect(game.clearing).toBeNull();
    expect(game.lines).toBe(1);
    expect(game.board[ROWS - 1].every(cell => cell === null)).toBe(true);
    expect(game.drainEvents()).toContain('clear');
  });

  it('scores a tetris and pays 1.5× for back-to-back', () => {
    const game = new TetrisGame();
    fillRows(game, 4, [0]);
    place(game, 'I', 1, -2, 0);
    game.key('up', true);
    const first = game.score;
    expect(first).toBe(800 + (ROWS - 4) * 2);
    expect(game.drainEvents()).toContain('big');
    game.step(300);
    expect(game.lines).toBe(4);

    fillRows(game, 4, [0]);
    place(game, 'I', 1, -2, 0);
    game.key('up', true);
    // 1200（背靠背）+ 50（连击 1）+ 硬降分
    expect(game.score - first).toBe(1200 + 50 + (ROWS - 4) * 2);
  });

  it('holds a piece once per drop', () => {
    const game = new TetrisGame();
    const first = game.active!.kind;
    const next = game.queue[0];
    game.key('l', true);
    expect(game.hold).toBe(first);
    expect(game.active!.kind).toBe(next);
    game.key('r', true);
    expect(game.hold).toBe(first); // 这一块已经换过，不能再换
  });

  it('auto-repeats sideways after the initial delay while held', () => {
    const game = new TetrisGame();
    place(game, 'O', 0, 4, 5);
    game.key('right', true);
    expect(game.active!.x).toBe(5);
    game.step(100);
    expect(game.active!.x).toBe(5);
    for (let i = 0; i < 20; i++) game.step(16);
    expect(game.active!.x).toBe(COLS - 2);
  });

  it('locks a grounded piece after the lock delay', () => {
    const game = new TetrisGame();
    place(game, 'O', 0, 4, ROWS - 2);
    game.step(300);
    expect(game.board[ROWS - 1][4]).toBeNull();
    game.step(250);
    expect(game.board[ROWS - 1][4]).toBe('O');
  });

  it('tops out when a new piece cannot spawn', () => {
    const game = new TetrisGame();
    // 堵住出生区（顶部 4 行留出最左两列，避免凑成整行被消掉）
    for (let y = 0; y < 4; y++) for (let x = 2; x < COLS; x++) game.board[y][x] = 'Z';
    place(game, 'O', 0, 0, ROWS - 2);
    game.key('up', true);
    expect(game.over).toBe(true);
  });

  it('falls faster as the level rises', () => {
    expect(gravityMs(1)).toBe(1000);
    expect(gravityMs(5)).toBeLessThan(gravityMs(2));
    expect(gravityMs(20)).toBeGreaterThanOrEqual(16);
  });
});
