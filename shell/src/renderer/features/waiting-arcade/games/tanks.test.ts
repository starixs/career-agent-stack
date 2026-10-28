import { describe, expect, it } from 'vitest';

import { buildMap, CELL, COLS, LEVELS, PLAYER_SPAWN, ROWS, TANK, TankGame, Tile, type Tank } from './tanks';

const fixedRng = (value: number) => () => value;

/** 空地图，不再刷敌军；右上角停一辆不动的敌车，免得一开局就判过关。 */
function quietGame(): TankGame {
  const game = new TankGame(fixedRng(0.5));
  game.enemiesLeft = 0;
  game.introMs = 0;
  game.tanks = game.tanks.filter(t => t.side === 'player');
  game.map = new Uint8Array(COLS * ROWS);
  enemyAt(game, 14 * TANK, 0);
  return game;
}

function enemyAt(game: TankGame, x: number, y: number, hp = 1): Tank {
  const e: Tank = {
    x, y, dir: 'down', side: 'enemy', kind: hp > 1 ? 'armored' : 'basic', speed: 0, coolMs: 99999,
    fireMs: 99999, invulnMs: 0, hp, dead: false, thinkMs: 99999, stuckMs: 0, flashMs: 0,
  };
  game.tanks.push(e);
  return e;
}

describe('TankGame', () => {
  it('builds every level as 15×9 tiles with the spawns and player cell left open', () => {
    for (const level of LEVELS) {
      expect(level.rows).toHaveLength(9);
      for (const row of level.rows) expect(row).toHaveLength(15);
      const map = buildMap(level.rows);
      const at = (px: number, py: number) => map[Math.floor(py / CELL) * COLS + Math.floor(px / CELL)];
      for (const x of [0, 7 * TANK, 14 * TANK]) expect(at(x, 0)).toBe(Tile.Empty);
      expect(at(PLAYER_SPAWN.x, PLAYER_SPAWN.y)).toBe(Tile.Empty);
      expect(at(7 * TANK, 8 * TANK)).toBe(Tile.Base);
    }
  });

  it('drives with the most recently held direction and stops at walls', () => {
    const game = quietGame();
    const p = game.player!;
    game.key('up', true);
    game.key('left', true);
    game.step(500);
    expect(p.dir).toBe('left');
    expect(p.x).toBeLessThan(PLAYER_SPAWN.x);
    game.key('left', false);
    game.step(100);
    expect(p.dir).toBe('up');
    game.step(20000);
    expect(p.y).toBe(0);
  });

  it('shoots away a brick and scores an enemy kill', () => {
    const game = quietGame();
    const p = game.player!;
    const cx = Math.floor((p.x + TANK / 2) / CELL);
    const brickRow = Math.floor(p.y / CELL) - 3;
    game.map[brickRow * COLS + cx] = Tile.Brick;
    game.key('a', true);
    game.step(16);
    game.key('a', false);
    for (let i = 0; i < 20; i++) game.step(16);
    expect(game.map[brickRow * COLS + cx]).toBe(Tile.Empty);
    expect(game.drainEvents()).toContain('hit');

    enemyAt(game, p.x, p.y - 3 * TANK);
    game.step(400);
    game.key('a', true);
    for (let i = 0; i < 30; i++) game.step(16);
    expect(game.score).toBe(100);
    expect(game.drainEvents()).toContain('score');
  });

  it('needs three hits to stop an armored tank', () => {
    const game = quietGame();
    const p = game.player!;
    const e = enemyAt(game, p.x, p.y - 3 * TANK, 3);
    game.key('a', true);
    for (let i = 0; i < 25; i++) game.step(16);
    expect(e.hp).toBe(2);
    for (let i = 0; i < 80; i++) game.step(16);
    expect(e.dead || !game.tanks.includes(e)).toBe(true);
    expect(game.score).toBe(300);
  });

  it('ends the game shortly after the base falls', () => {
    const game = quietGame();
    game.bullets.push({ x: 7 * TANK + 6, y: 8 * TANK - 6, dir: 'down', owner: 'enemy', speed: 0.125, dead: false });
    game.map = buildMap(LEVELS[0].rows);
    game.map.fill(Tile.Empty, 0, COLS * 15);
    game.step(100);
    expect(game.baseAlive).toBe(false);
    expect(game.over).toBe(false);
    game.step(1200);
    expect(game.over).toBe(true);
  });

  it('loses a life when hit and respawns, game over at zero', () => {
    const game = quietGame();
    const hitPlayer = () => {
      const p = game.player!;
      p.invulnMs = 0;
      game.bullets.push({ x: p.x + 6, y: p.y - 4, dir: 'down', owner: 'enemy', speed: 0.125, dead: false });
      game.step(50);
    };
    hitPlayer();
    expect(game.lives).toBe(2);
    expect(game.player).toBeNull();
    game.step(1300);
    expect(game.player).not.toBeNull();
    hitPlayer();
    game.step(1300);
    hitPlayer();
    expect(game.lives).toBe(0);
    game.step(1200);
    expect(game.over).toBe(true);
  });

  it('clears the stage when every enemy is gone and loops harder maps', () => {
    const game = quietGame();
    game.tanks = game.tanks.filter(t => t.side === 'player');
    game.step(16);
    expect(game.clearMs).toBeGreaterThan(0);
    expect(game.drainEvents()).toContain('levelup');
    game.step(1600);
    expect(game.level).toBe(2);
    expect(game.enemiesLeft).toBe(LEVELS[1].enemies);

    game.level = LEVELS.length;
    game.enemiesLeft = 0;
    game.tanks = game.tanks.filter(t => t.side === 'player');
    game.step(16);
    game.step(1600);
    expect(game.level).toBe(LEVELS.length + 1);
    expect(game.enemiesLeft).toBe(LEVELS[0].enemies + 2);
  });
});
