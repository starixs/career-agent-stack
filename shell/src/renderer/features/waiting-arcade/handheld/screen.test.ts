import { describe, expect, it, vi } from 'vitest';

import { BreakoutGame } from '../games/breakout';
import { keyToButton } from './keys';
import { BOOT_MS, HandheldScreen, type ScreenText } from './screen';

const TEXT: ScreenText = {
  wordmark: 'POCKET',
  menuTitle: '选择游戏',
  menuHint: '',
  best: '最高',
  paused: '暂停',
  pausedHint: '',
  gameOver: '游戏结束',
  newRecord: '新纪录！',
  overHint: '',
  games: { tetris: '俄罗斯方块', snake: '贪吃蛇', breakout: '打砖块', runner: '跳跳小人' },
};

function makeScreen(initialGame: 'tetris' | 'snake' | 'breakout' | 'runner' = 'snake') {
  const store = new Map<string, number>();
  const sounds: string[] = [];
  const onGameChange = vi.fn();
  const screen = new HandheldScreen({
    text: TEXT,
    initialGame,
    best: { read: id => store.get(id) ?? 0, write: (id, n) => store.set(id, n) },
    onSound: s => sounds.push(s),
    onGameChange,
  });
  return { screen, store, sounds, onGameChange };
}

describe('HandheldScreen', () => {
  it('boots into the menu by itself, or right away on A', () => {
    const { screen, sounds } = makeScreen();
    expect(screen.mode).toBe('boot');
    screen.step(BOOT_MS);
    expect(screen.mode).toBe('menu');
    expect(sounds).toContain('boot');

    const skipped = makeScreen().screen;
    skipped.press('a');
    expect(skipped.mode).toBe('menu');
  });

  it('wraps the menu cursor and starts the chosen game', () => {
    const { screen, onGameChange } = makeScreen('tetris');
    screen.press('start');
    screen.press('up');
    expect(screen.gameId).toBe('runner');
    screen.press('down');
    screen.press('down');
    screen.press('down');
    expect(screen.gameId).toBe('breakout');
    screen.press('a');
    expect(screen.mode).toBe('playing');
    expect(screen.game).toBeInstanceOf(BreakoutGame);
    expect(onGameChange).toHaveBeenCalledWith('breakout');
  });

  it('pauses on START, resumes on START, and SELECT goes back to the menu', () => {
    const { screen } = makeScreen();
    screen.press('a');
    screen.press('a');
    expect(screen.mode).toBe('playing');
    screen.press('start');
    expect(screen.mode).toBe('paused');
    screen.press('start');
    expect(screen.mode).toBe('playing');
    screen.press('select');
    expect(screen.mode).toBe('menu');
    expect(screen.game).toBeNull();
  });

  it('shows an outside notice while paused and clears it on resume', () => {
    const { screen } = makeScreen();
    screen.press('a');
    screen.press('a');
    screen.pause('AI 回复好了');
    expect(screen.mode).toBe('paused');
    expect(screen.notice).toBe('AI 回复好了');
    screen.press('a');
    expect(screen.mode).toBe('playing');
    expect(screen.notice).toBeNull();
  });

  it('passes A, B, L and R to the game as separate buttons and plays their sounds', () => {
    const { screen, sounds } = makeScreen('tetris');
    screen.press('a');
    screen.press('a');
    const game = screen.game!;
    const key = vi.spyOn(game, 'key');
    screen.press('b');
    screen.press('l');
    screen.release('b');
    expect(key).toHaveBeenCalledWith('b', true);
    expect(key).toHaveBeenCalledWith('l', true);
    expect(key).toHaveBeenCalledWith('b', false);
    expect(sounds).toContain('tick'); // 旋转 / 暂存的提示音
  });

  it('records a new best, ends the run, and restarts with A', () => {
    const { screen, store, sounds } = makeScreen('breakout');
    screen.press('a');
    screen.press('a');
    const game = screen.game as BreakoutGame;
    game.score = 120;
    game.lives = 1;
    game.docked = false;
    game.ball = { x: 5, y: 400, vx: 0, vy: 0.1 };
    screen.step(16);
    expect(screen.mode).toBe('over');
    expect(store.get('breakout')).toBe(120);
    expect(screen.best('breakout')).toBe(120);
    expect(screen.newRecord).toBe(true);
    expect(sounds).toContain('over');
    screen.press('a');
    expect(screen.mode).toBe('playing');
    expect(screen.score).toBe(0);
  });
});

describe('keyToButton', () => {
  it('maps physical keys onto handheld buttons', () => {
    expect(keyToButton('ArrowLeft')).toBe('left');
    expect(keyToButton('KeyW')).toBe('up');
    expect(keyToButton('KeyX')).toBe('a');
    expect(keyToButton('Space')).toBe('a');
    expect(keyToButton('KeyZ')).toBe('b');
    expect(keyToButton('Enter')).toBe('start');
    expect(keyToButton('ShiftRight')).toBe('select');
    expect(keyToButton('KeyQ')).toBe('l');
    expect(keyToButton('KeyP')).toBeNull();
  });
});
