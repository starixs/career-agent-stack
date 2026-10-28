import { describe, expect, it } from 'vitest';

import { BOOT_MS, HandheldScreen, OVER_DELAY_MS, type ScreenText } from '../handheld/screen';
import { ARCADE_GAME_IDS, createArcadeGame, type ArcadeAction } from './index';
import { ShooterGame } from './shooter';
import { ShredderGame, type Letter } from './shredder';
import { SnakeGame, TURN_EARLY_MS } from './snake';
import { SurvivorGame } from './survivor';

const fixedRng = (value: number) => () => value;

describe('SnakeGame responsiveness', () => {
  it('turns on the key press instead of waiting for the next step', () => {
    const game = new SnakeGame(fixedRng(0));
    game.food = { x: 0, y: 0 };
    game.step(TURN_EARLY_MS + 5);
    const head = game.body[0];
    game.key('up', true);
    expect(game.body[0]).toEqual({ x: head.x, y: head.y - 1 });
  });

  it('does not let rapid turning outrun the normal pace', () => {
    const game = new SnakeGame(fixedRng(0));
    game.food = { x: 0, y: 0 };
    const head = game.body[0];
    game.key('up', true);
    game.key('right', true);
    // 刚开局 acc=0，两个转向都排队，不会瞬移两格
    expect(game.body[0]).toEqual(head);
  });
});

describe('SurvivorGame', () => {
  it('auto-fires at the nearest enemy, levels up from gems and offers three upgrades', () => {
    const game = new SurvivorGame(fixedRng(0.5));
    game.enemies = [{ x: game.x + 30, y: game.y, kind: 'blob', hp: 1, flashMs: 0, orbitCd: 0 }];
    for (let i = 0; i < 40 && game.score === 0; i++) game.step(16);
    expect(game.score).toBeGreaterThan(0);
    expect(game.gems.length).toBe(1);

    game.gems = [{ x: game.x, y: game.y, xp: game.xpNeed }];
    game.step(16);
    expect(game.level).toBe(2);
    expect(game.choices).toHaveLength(3);
    expect(game.drainFx().some(f => f.kind === 'burst')).toBe(true);

    const before = game.enemies.length;
    game.step(1000);
    expect(game.enemies.length).toBe(before); // 选卡时世界暂停
    const pick = game.choices![1];
    game.key('right', true);
    game.key('a', true);
    expect(game.choices).toBeNull();
    expect(game.ups[pick]).toBe(1);
  });

  it('loses a heart on contact and ends at zero', () => {
    const game = new SurvivorGame(fixedRng(0.5));
    game.lives = 1;
    game.enemies = [{ x: game.x, y: game.y, kind: 'blob', hp: 5, flashMs: 0, orbitCd: 0 }];
    game.step(16);
    expect(game.over).toBe(true);
  });
});

describe('ShooterGame', () => {
  it('drops a power capsule from the last plane of a wave and powers up', () => {
    const game = new ShooterGame(fixedRng(0.5));
    game.foes = [{ x: game.x + 30, y: game.y, vx: 0, kind: 'zig', hp: 1, maxHp: 1, t: 0, baseY: game.y, fireCd: 9999, flashMs: 0, carrier: true }];
    for (let i = 0; i < 20; i++) game.step(16);
    expect(game.capsules).toHaveLength(1);
    game.capsules[0].x = game.x;
    game.capsules[0].y = game.y;
    game.step(16);
    expect(game.power).toBe(2);
  });

  it('bombs clear the screen once per charge', () => {
    const game = new ShooterGame(fixedRng(0.5));
    game.foes = [{ x: 200, y: 80, vx: 0, kind: 'dart', hp: 2, maxHp: 2, t: 0, baseY: 80, fireCd: 9999, flashMs: 0, carrier: false }];
    game.enemyShots = [{ x: 100, y: 80, vx: -0.1, vy: 0 }];
    game.key('b', true);
    expect(game.bombs).toBe(1);
    expect(game.enemyShots).toHaveLength(0);
    game.step(16);
    expect(game.foes).toHaveLength(0);
  });

  it('sends a boss on schedule and beating it advances the stage', () => {
    const game = new ShooterGame(fixedRng(0.5));
    game.bossMs = 10;
    game.step(16);
    const boss = game.boss!;
    expect(boss).toBeDefined();
    boss.hp = 1;
    game.invulnMs = 99999;
    for (let i = 0; i < 200 && game.boss; i++) game.step(16);
    expect(game.level).toBe(2);
  });
});

describe('ShredderGame', () => {
  const letter = (game: ShredderGame, kind: Letter['kind'], y: number, x = game.x): Letter => {
    const l: Letter = { x, y, kind, hp: kind === 'ghost' ? 2 : 1, wobble: 0, flashMs: 0 };
    game.letters.push(l);
    return l;
  };

  it('shreds a rejection when shot', () => {
    const game = new ShredderGame(fixedRng(0.99));
    letter(game, 'reject', 90);
    game.key('a', true);
    for (let i = 0; i < 30; i++) game.step(16);
    expect(game.shredded).toBeGreaterThanOrEqual(1);
    expect(game.score).toBeGreaterThan(0);
  });

  it('costs a heart when a rejection lands', () => {
    const game = new ShredderGame(fixedRng(0.99));
    letter(game, 'reject', 158, 20);
    game.x = 200;
    game.step(400);
    expect(game.lives).toBe(2);
  });

  it('catching an offer starts fever and wipes the rejections on screen', () => {
    const game = new ShredderGame(fixedRng(0.99));
    letter(game, 'reject', 40, 30);
    letter(game, 'reject', 60, 200);
    letter(game, 'offer', 143);
    game.step(30);
    expect(game.feverMs).toBeGreaterThan(0);
    expect(game.letters.filter(l => l.kind === 'reject')).toHaveLength(0);
    expect(game.shredded).toBe(2);
  });

  it('shooting an invite loses it without costing a heart', () => {
    const game = new ShredderGame(fixedRng(0.99));
    letter(game, 'invite', 100);
    game.key('a', true);
    for (let i = 0; i < 30; i++) game.step(16);
    expect(game.lives).toBe(3);
    expect(game.letters).toHaveLength(0);
  });

  it('moves to the next week after 20 shreds', () => {
    const game = new ShredderGame(fixedRng(0.99));
    game.shredded = 19;
    letter(game, 'reject', 90);
    game.key('a', true);
    for (let i = 0; i < 30 && game.level === 1; i++) game.step(16);
    expect(game.level).toBe(2);
  });
});

describe('every game survives three minutes of button mashing', () => {
  const actions: ArcadeAction[] = ['up', 'down', 'left', 'right', 'a', 'b'];
  for (const id of ARCADE_GAME_IDS) {
    it(id, () => {
      let seed = 7;
      const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const game = createArcadeGame(id);
      for (let frame = 0; frame < 180 * 60 && !game.over; frame++) {
        if (frame % 9 === 0) {
          game.key(actions[Math.floor(rng() * actions.length)], rng() < 0.6);
          // 幸存者选卡时按 A 选掉，免得一直停在卡片上
          if (game instanceof SurvivorGame && game.choices) game.pick(0);
        }
        game.step(16);
        game.drainEvents();
        game.drainFx();
      }
      expect(Number.isFinite(game.score)).toBe(true);
      expect(game.score).toBeGreaterThanOrEqual(0);
    });
  }
});

describe('HandheldScreen feedback', () => {
  const TEXT = {
    wordmark: 'POCKET', menuTitle: '', menuHint: '', best: '', paused: '', pausedHint: '', gameOver: '', newRecord: 'NEW', overHint: '',
    games: Object.fromEntries(ARCADE_GAME_IDS.map(id => [id, id])),
  } as ScreenText;

  it('freezes game logic during a hitstop while effects keep running', () => {
    const screen = new HandheldScreen({ text: TEXT, best: { read: () => 0, write: () => {} }, initialGame: 'snake' });
    screen.step(BOOT_MS);
    screen.press('a');
    const game = screen.game as SnakeGame;
    screen.fx.push([{ kind: 'hitstop', ms: 100 }]);
    const head = game.body[0];
    screen.step(60);
    expect(game.body[0]).toBe(head);
    screen.step(200);
    expect(game.body[0]).not.toBe(head);
  });

  it('pitches the score sound up with the combo', () => {
    const sounds: [string, number | undefined][] = [];
    const screen = new HandheldScreen({
      text: TEXT, best: { read: () => 0, write: () => {} }, initialGame: 'breakout',
      onSound: (s, semi) => sounds.push([s, semi]),
    });
    screen.step(BOOT_MS);
    screen.press('a');
    const game = screen.game!;
    (game as unknown as { fx: (...f: unknown[]) => void }).fx({ kind: 'combo', n: 4 });
    (game as unknown as { emit: (e: string) => void }).emit('score');
    screen.step(16);
    expect(sounds).toContainEqual(['score', 6]);
    expect(sounds.filter(([s, semi]) => s === 'score' && !semi)).toHaveLength(0);
  });

  it('keeps animating through the game-over delay', () => {
    const screen = new HandheldScreen({ text: TEXT, best: { read: () => 0, write: () => {} }, initialGame: 'survivor' });
    screen.step(BOOT_MS);
    screen.press('a');
    const game = screen.game as SurvivorGame;
    game.lives = 1;
    game.enemies = [{ x: game.x, y: game.y, kind: 'blob', hp: 5, flashMs: 0, orbitCd: 0 }];
    screen.step(16);
    expect(screen.mode).toBe('over');
    expect(screen.animating).toBe(true);
    expect(screen.overReady).toBe(false);
    screen.step(OVER_DELAY_MS);
    expect(screen.overReady).toBe(true);
  });
});
