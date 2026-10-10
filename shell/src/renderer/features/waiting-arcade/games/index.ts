import { BreakoutGame } from './breakout';
import { RunnerGame } from './runner';
import { SnakeGame } from './snake';
import { TetrisGame } from './tetris';
import type { ArcadeGame, ArcadeGameId } from './types';

export const ARCADE_GAME_IDS: readonly ArcadeGameId[] = ['tetris', 'snake', 'breakout', 'runner'];

export function createArcadeGame(id: ArcadeGameId): ArcadeGame {
  switch (id) {
    case 'tetris': return new TetrisGame();
    case 'snake': return new SnakeGame();
    case 'breakout': return new BreakoutGame();
    case 'runner': return new RunnerGame();
  }
}

export * from './types';
