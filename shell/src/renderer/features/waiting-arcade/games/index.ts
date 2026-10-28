import { BreakoutGame } from './breakout';
import { RunnerGame } from './runner';
import { ShooterGame } from './shooter';
import { ShredderGame } from './shredder';
import { SnakeGame } from './snake';
import { SurvivorGame } from './survivor';
import { TankGame } from './tanks';
import { TetrisGame } from './tetris';
import type { ArcadeGame, ArcadeGameId } from './types';

/** 菜单顺序：爽感最直接的放前面，求职题材的放第一个。 */
export const ARCADE_GAME_IDS: readonly ArcadeGameId[] = [
  'shredder', 'survivor', 'shooter', 'tank', 'breakout', 'snake', 'runner', 'tetris',
];

export const DEFAULT_GAME: ArcadeGameId = 'shredder';

export function createArcadeGame(id: ArcadeGameId): ArcadeGame {
  switch (id) {
    case 'tetris': return new TetrisGame();
    case 'snake': return new SnakeGame();
    case 'breakout': return new BreakoutGame();
    case 'runner': return new RunnerGame();
    case 'tank': return new TankGame();
    case 'survivor': return new SurvivorGame();
    case 'shooter': return new ShooterGame();
    case 'shredder': return new ShredderGame();
  }
}

export * from './types';
