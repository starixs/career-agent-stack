import { BreakoutGame } from './breakout';
import { RunnerGame } from './runner';
import { SnakeGame } from './snake';
import type { ArcadeAction, ArcadeGame, ArcadeGameId } from './types';

export const ARCADE_GAME_IDS: readonly ArcadeGameId[] = ['snake', 'breakout', 'runner'];

export function createArcadeGame(id: ArcadeGameId): ArcadeGame {
  switch (id) {
    case 'snake': return new SnakeGame();
    case 'breakout': return new BreakoutGame();
    case 'runner': return new RunnerGame();
  }
}

const KEY_ACTIONS: Record<string, ArcadeAction> = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'action', Enter: 'action',
};

/** 按 KeyboardEvent.code 映射，避免输入法 / 键盘布局影响 WASD。 */
export function keyToArcadeAction(code: string): ArcadeAction | null {
  return KEY_ACTIONS[code] ?? null;
}

export * from './types';
