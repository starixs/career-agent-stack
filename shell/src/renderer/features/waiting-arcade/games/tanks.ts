// 坦克大战：守住底部基地，消灭每关全部敌军。砖墙能打碎、钢墙打不动、
// 河流挡车不挡子弹、树林会遮住坦克。三种敌军（普通 / 快速 / 装甲三血），
// 4 张地图循环，循环一轮后敌人更多、更快、开火更勤。
// 移植自独立的 tank-battle.html，尺寸按掌机屏缩成 16px 坦克、8px 地形格。

import {
  ARCADE_HEIGHT,
  ARCADE_WIDTH,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

export const CELL = 8;
export const TANK = 16;
export const COLS = ARCADE_WIDTH / CELL; // 30
export const ROWS = 18;
/** 顶部留一条给屏幕 HUD，地图画在下面。 */
export const FIELD_Y = ARCADE_HEIGHT - ROWS * CELL;
const FIELD_W = COLS * CELL;
const FIELD_H = ROWS * CELL;

export const Tile = { Empty: 0, Brick: 1, Steel: 2, Water: 3, Tree: 4, Base: 5 } as const;
type TileValue = (typeof Tile)[keyof typeof Tile];

export type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Record<Dir, { x: number; y: number }> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const DIR_NAMES: readonly Dir[] = ['up', 'down', 'left', 'right'];

export const BASE_X = 7 * TANK;
export const BASE_Y = 8 * TANK;
export const PLAYER_SPAWN = { x: 4 * TANK, y: 8 * TANK };
const SPAWNS: readonly [number, number][] = [[0, 0], [7 * TANK, 0], [14 * TANK, 0]];

/**
 * 暗色屏（取自原版）：暗底上的金色自机和发光子弹最带劲，所以坦克不用掌机的 LCD 配色。
 * primary 金色自机，accent 橙色快车与敌弹，ink 装甲车，muted 普通车，danger 砖墙。
 */
export const TANK_PALETTE: ArcadePalette = {
  bg: '#0d0f12',
  ink: '#e6e9ee',
  muted: '#8d99a6',
  line: '#2a3340',
  primary: '#e8c34a',
  accent: '#ff8c42',
  danger: '#c05c3e',
};

const START_LIVES = 3;
const MAX_LIVES = 5;
const LIFE_EVERY = 4000;
const PLAYER_SPEED = 0.056; // px / ms
const PLAYER_FIRE_MS = 300;
const PLAYER_BULLET = 0.17;
const ENEMY_BULLET = 0.125;
const BULLET = 4;
const RESPAWN_MS = 1200;
const SPAWN_INVULN_MS = 2400;
const CLEAR_MS = 1500;
const DYING_MS = 1100;
const INTRO_MS = 1100;

/**
 * 15×9 图块（每块 16px = 2×2 地形格）：. 空地  b 砖墙  s 钢墙  w 河流  t 树林  E 基地。
 * 出生点（左上 / 正中 / 右上）和玩家出生格 (4,8) 必须留空。
 */
export const LEVELS: readonly { enemies: number; maxAlive: number; rows: string[] }[] = [
  {
    enemies: 6, maxAlive: 3,
    rows: [
      '...............',
      '.bb..b...b..bb.',
      '.bb..b.s.b..bb.',
      '.....b...b.....',
      '..s.........s..',
      '.bb..bbbbb..bb.',
      '.....b...b.....',
      '..b...bbb...b..',
      '..b...bEb...b..',
    ],
  },
  {
    enemies: 8, maxAlive: 3,
    rows: [
      '...............',
      '.ss...s.s...ss.',
      '.s...........s.',
      '.s.bb.www.bb.s.',
      '...b..www..b...',
      '...b.......b...',
      '.s.bb.bbb.bb.s.',
      '..ss..bbb..ss..',
      '......bEb......',
    ],
  },
  {
    enemies: 10, maxAlive: 4,
    rows: [
      '...............',
      '.ttt..b.b..ttt.',
      '.ttt..b.b..ttt.',
      '.bbb.......bbb.',
      '.....s...s.....',
      '.b.b..ttt..b.b.',
      '.b.b..ttt..b.b.',
      '..bb..bbb..bb..',
      '..tt..bEb..tt..',
    ],
  },
  {
    enemies: 12, maxAlive: 4,
    rows: [
      '...............',
      '.s.b.......b.s.',
      '.s.b..sss..b.s.',
      '.....b...b.....',
      '.bb.ss.w.ss.bb.',
      '.....b...b.....',
      '.s.b..bbb..b.s.',
      '.....bbbbb.....',
      '......bEb......',
    ],
  },
];

export type EnemyKind = 'basic' | 'fast' | 'armored';
const ENEMY_KINDS: Record<EnemyKind, { speed: number; hp: number; points: number }> = {
  basic: { speed: 0.031, hp: 1, points: 100 },
  fast: { speed: 0.049, hp: 1, points: 200 },
  armored: { speed: 0.0275, hp: 3, points: 300 },
};

export interface Tank {
  x: number;
  y: number;
  dir: Dir;
  side: 'player' | 'enemy';
  kind: EnemyKind | null;
  speed: number;
  coolMs: number;
  fireMs: number;
  invulnMs: number;
  hp: number;
  dead: boolean;
  thinkMs: number;
  stuckMs: number;
  flashMs: number;
}

export interface Bullet { x: number; y: number; dir: Dir; owner: 'player' | 'enemy'; speed: number; dead: boolean }
type Spark = 'fire' | 'brick' | 'steel' | 'flash';
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; kind: Spark }

export function buildMap(rows: readonly string[]): Uint8Array {
  const tiles: Record<string, TileValue> = { b: Tile.Brick, s: Tile.Steel, w: Tile.Water, t: Tile.Tree, E: Tile.Base };
  const map = new Uint8Array(COLS * ROWS);
  rows.forEach((row, ty) => {
    [...row].forEach((ch, tx) => {
      const v = tiles[ch] ?? Tile.Empty;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) map[(ty * 2 + dy) * COLS + tx * 2 + dx] = v;
      }
    });
  });
  return map;
}

function blocksTank(v: number): boolean {
  return v === Tile.Brick || v === Tile.Steel || v === Tile.Water || v === Tile.Base;
}

export class TankGame extends EventfulGame implements ArcadeGame {
  readonly palette = TANK_PALETTE;
  score = 0;
  over = false;
  lives = START_LIVES;
  level = 1;
  map: Uint8Array = new Uint8Array(COLS * ROWS);
  tanks: Tank[] = [];
  bullets: Bullet[] = [];
  player: Tank | null = null;
  baseAlive = true;
  /** 还没出场的敌军数。 */
  enemiesLeft = 0;
  spawnMs = 0;
  respawnMs = 0;
  clearMs = 0;
  dyingMs = 0;
  introMs = 0;
  private parts: Particle[] = [];
  private time = 0;
  private shake = 0;
  private nextLifeAt = LIFE_EVERY;
  /** 按下顺序记方向键，松开后回到仍按着的上一个方向。 */
  private heldDirs: Dir[] = [];
  /** 不死连杀数，连杀时得分音逐级升高。 */
  private killStreak = 0;
  private firing = false;

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  /** 场上 + 待出场的敌军总数。 */
  get enemiesRemaining(): number {
    return this.enemiesLeft + this.tanks.filter(t => t.side === 'enemy').length;
  }

  /** 第几张地图（0 起），以及已经循环了几轮。 */
  private get stageDef() {
    const idx = (this.level - 1) % LEVELS.length;
    return { idx, cycle: Math.floor((this.level - 1) / LEVELS.length), def: LEVELS[idx] };
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.lives = START_LIVES;
    this.level = 1;
    this.killStreak = 0;
    this.nextLifeAt = LIFE_EVERY;
    this.heldDirs = [];
    this.firing = false;
    this.startLevel();
  }

  private startLevel(): void {
    const { def, cycle } = this.stageDef;
    this.map = buildMap(def.rows);
    this.tanks = [];
    this.bullets = [];
    this.parts = [];
    this.baseAlive = true;
    this.enemiesLeft = def.enemies + cycle * 2;
    this.spawnMs = 500;
    this.respawnMs = 0;
    this.clearMs = 0;
    this.dyingMs = 0;
    this.introMs = INTRO_MS;
    this.shake = 0;
    this.spawnPlayer();
  }

  key(action: ArcadeAction, down: boolean): void {
    if (action === 'a' || action === 'b') {
      this.firing = down;
      return;
    }
    if (action === 'l' || action === 'r') return;
    this.heldDirs = this.heldDirs.filter(d => d !== action);
    if (down) this.heldDirs.push(action);
  }

  step(dtMs: number): void {
    if (this.over) return;
    this.time += dtMs;
    this.updateParts(dtMs);
    this.shake = Math.max(0, this.shake - dtMs * 0.0024);
    if (this.dyingMs > 0) {
      this.dyingMs -= dtMs;
      if (this.dyingMs <= 0) this.over = true;
      return;
    }
    if (this.clearMs > 0) {
      this.clearMs -= dtMs;
      if (this.clearMs <= 0) {
        this.level += 1;
        this.startLevel();
      }
      return;
    }
    this.introMs = Math.max(0, this.introMs - dtMs);
    this.updatePlayer(dtMs);
    for (const t of this.tanks) if (t.side === 'enemy' && !t.dead) this.updateEnemy(t, dtMs);
    this.updateBullets(dtMs);
    this.trySpawnEnemy(dtMs);
    this.tanks = this.tanks.filter(t => !t.dead);
    if (this.dyingMs <= 0 && this.enemiesRemaining === 0) {
      this.clearMs = CLEAR_MS;
      this.score += 500;
      this.emit('levelup');
      this.fx({ kind: 'banner', text: `STAGE ${this.level} CLEAR`, sub: '+500' }, { kind: 'hitstop', ms: 90 });
      this.checkLife();
    }
  }

  // ─── 地形与碰撞 ─────────────────────────────────────────

  tileAt(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return Tile.Steel;
    return this.map[cy * COLS + cx];
  }

  private rectHitsTiles(x: number, y: number, w: number, h: number): boolean {
    const x0 = Math.floor(x / CELL), x1 = Math.floor((x + w - 0.01) / CELL);
    const y0 = Math.floor(y / CELL), y1 = Math.floor((y + h - 0.01) / CELL);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) if (blocksTank(this.tileAt(cx, cy))) return true;
    }
    return false;
  }

  private tankBlocked(t: Tank, x: number, y: number): boolean {
    if (this.rectHitsTiles(x, y, TANK, TANK)) return true;
    return this.tanks.some(o => o !== t && !o.dead
      && x < o.x + TANK && x + TANK > o.x && y < o.y + TANK && y + TANK > o.y);
  }

  /** 转向时把垂直轴吸附到地形格，保证能钻进一格宽的通道。 */
  private snapAxis(t: Tank, axis: 'x' | 'y'): void {
    const v = t[axis];
    const r = Math.round(v / CELL) * CELL;
    for (const c of [r, r - CELL, r + CELL]) {
      if (c < 0 || c > (axis === 'x' ? FIELD_W : FIELD_H) - TANK) continue;
      const nx = axis === 'x' ? c : t.x;
      const ny = axis === 'y' ? c : t.y;
      if (!this.tankBlocked(t, nx, ny)) {
        t[axis] = c;
        return;
      }
    }
  }

  private turn(t: Tank, dir: Dir): void {
    if (t.dir === dir) return;
    t.dir = dir;
    this.snapAxis(t, dir === 'up' || dir === 'down' ? 'x' : 'y');
  }

  private moveTank(t: Tank, dtMs: number): boolean {
    const d = DIRS[t.dir];
    let remain = t.speed * dtMs;
    let moved = false;
    while (remain > 0.001) {
      const s = Math.min(remain, 1);
      const nx = t.x + d.x * s, ny = t.y + d.y * s;
      if (this.tankBlocked(t, nx, ny)) {
        // 墙都在整数像素上：被挡时贴到整数边，否则会留下不到 1px 的缝
        const ex = d.x > 0 ? Math.ceil(t.x) : d.x < 0 ? Math.floor(t.x) : t.x;
        const ey = d.y > 0 ? Math.ceil(t.y) : d.y < 0 ? Math.floor(t.y) : t.y;
        if ((ex !== t.x || ey !== t.y) && !this.tankBlocked(t, ex, ey)) {
          t.x = ex;
          t.y = ey;
          moved = true;
        }
        break;
      }
      t.x = nx;
      t.y = ny;
      moved = true;
      remain -= s;
    }
    return moved;
  }

  // ─── 坦克 ───────────────────────────────────────────────

  private makeTank(x: number, y: number, dir: Dir, side: Tank['side'], kind: EnemyKind | null): Tank {
    return {
      x, y, dir, side, kind,
      speed: PLAYER_SPEED, coolMs: 0, fireMs: PLAYER_FIRE_MS, invulnMs: 0,
      hp: 1, dead: false, thinkMs: 0, stuckMs: 0, flashMs: 0,
    };
  }

  private spawnPlayer(): void {
    const p = this.makeTank(PLAYER_SPAWN.x, PLAYER_SPAWN.y, 'up', 'player', null);
    p.invulnMs = SPAWN_INVULN_MS;
    this.player = p;
    this.tanks.push(p);
  }

  private updatePlayer(dtMs: number): void {
    const p = this.player;
    if (p && !p.dead) {
      p.invulnMs = Math.max(0, p.invulnMs - dtMs);
      p.coolMs = Math.max(0, p.coolMs - dtMs);
      p.flashMs = Math.max(0, p.flashMs - dtMs);
      const dir = this.heldDirs[this.heldDirs.length - 1];
      if (dir) {
        this.turn(p, dir);
        this.moveTank(p, dtMs);
      }
      if (this.firing) this.fire(p);
    } else if (this.respawnMs > 0) {
      this.respawnMs -= dtMs;
      if (this.respawnMs <= 0 && this.lives > 0) this.spawnPlayer();
    }
  }

  private trySpawnEnemy(dtMs: number): void {
    if (this.enemiesLeft <= 0) return;
    const { def, cycle, idx } = this.stageDef;
    const alive = this.tanks.filter(t => t.side === 'enemy' && !t.dead).length;
    if (alive >= def.maxAlive + Math.min(1, cycle)) return;
    this.spawnMs -= dtMs;
    if (this.spawnMs > 0) return;

    const [sx, sy] = SPAWNS[Math.floor(this.rng() * SPAWNS.length)];
    if (this.tanks.some(o => !o.dead && Math.abs(o.x - sx) < TANK && Math.abs(o.y - sy) < TANK)) {
      this.spawnMs = 400;
      return;
    }
    const roll = this.rng();
    const kind: EnemyKind = roll < 0.55 ? 'basic' : roll < 0.82 ? 'fast' : 'armored';
    const spec = ENEMY_KINDS[kind];
    const difficulty = idx + cycle * LEVELS.length;
    const e = this.makeTank(sx, sy, 'down', 'enemy', kind);
    e.speed = Math.min(spec.speed * 1.5, spec.speed + difficulty * 0.002);
    e.hp = spec.hp;
    e.fireMs = Math.max(800, 2250 - difficulty * 150);
    e.coolMs = 600 + this.rng() * 1000;
    e.invulnMs = 700;
    e.thinkMs = 300 + this.rng() * 600;
    this.tanks.push(e);
    this.enemiesLeft -= 1;
    this.spawnMs = 1500 + this.rng() * 800;
    this.sparks(sx + TANK / 2, sy + TANK / 2, 'flash', 8);
  }

  private chooseEnemyDir(e: Tank): void {
    const dx = BASE_X + TANK / 2 - (e.x + TANK / 2);
    const dy = BASE_Y + TANK / 2 - (e.y + TANK / 2);
    const cands: Dir[] = [];
    // 多数时候朝基地方向拱，偶尔乱走，免得全挤在一条路上
    if (this.rng() < 0.62) {
      cands.push(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    }
    if (this.rng() < 0.35) {
      cands.push(dx > 0 ? 'right' : 'left', dy > 0 ? 'down' : 'up');
    }
    for (let i = 0; i < 6; i++) cands.push(DIR_NAMES[Math.floor(this.rng() * 4)]);
    const next = cands.find(d => d !== e.dir);
    if (next) this.turn(e, next);
  }

  /** 直线射界：中间没有砖墙 / 钢墙才算看得见。 */
  private lineClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy) / 4);
    for (let i = 1; i < steps; i++) {
      const v = this.tileAt(Math.floor((x0 + dx * i / steps) / CELL), Math.floor((y0 + dy * i / steps) / CELL));
      if (v === Tile.Brick || v === Tile.Steel) return false;
    }
    return true;
  }

  private aimedAtTarget(e: Tank): boolean {
    const targets: { x: number; y: number }[] = [];
    if (this.player && !this.player.dead) targets.push(this.player);
    if (this.baseAlive) targets.push({ x: BASE_X, y: BASE_Y });
    const ex = e.x + TANK / 2, ey = e.y + TANK / 2;
    return targets.some(target => {
      const tx = target.x + TANK / 2, ty = target.y + TANK / 2;
      if (Math.abs(tx - ex) + Math.abs(ty - ey) > 170) return false;
      const aimed = Math.abs(tx - ex) < 13
        ? (e.dir === 'down' && ty > ey) || (e.dir === 'up' && ty < ey)
        : Math.abs(ty - ey) < 13 && ((e.dir === 'right' && tx > ex) || (e.dir === 'left' && tx < ex));
      return aimed && this.lineClear(ex, ey, tx, ty);
    });
  }

  private updateEnemy(e: Tank, dtMs: number): void {
    e.coolMs = Math.max(0, e.coolMs - dtMs);
    e.invulnMs = Math.max(0, e.invulnMs - dtMs);
    e.flashMs = Math.max(0, e.flashMs - dtMs);
    if (this.moveTank(e, dtMs)) {
      e.stuckMs = 0;
    } else {
      e.stuckMs += dtMs;
      if (e.stuckMs > 120) {
        this.chooseEnemyDir(e);
        e.stuckMs = 0;
      }
    }
    e.thinkMs -= dtMs;
    if (e.thinkMs <= 0) {
      e.thinkMs = 700 + this.rng() * 900;
      if (this.rng() < 0.55) this.chooseEnemyDir(e);
    }
    if (e.coolMs <= 0 && (this.aimedAtTarget(e) || this.rng() < dtMs * 0.00085)) {
      this.fire(e);
      e.coolMs = e.fireMs * (0.85 + this.rng() * 0.65);
    }
  }

  private damageTank(t: Tank): void {
    t.hp -= 1;
    if (t.hp > 0) {
      t.flashMs = 180;
      this.sparks(t.x + TANK / 2, t.y + TANK / 2, 'fire', 6);
      this.emit('hit');
      return;
    }
    t.dead = true;
    this.boom(t.x + TANK / 2, t.y + TANK / 2, 18, 0.095);
    this.shake = Math.max(this.shake, 0.5);
    if (t.side === 'player') {
      this.player = null;
      this.killStreak = 0;
      this.lives -= 1;
      this.emit('lose');
      if (this.lives > 0) this.respawnMs = RESPAWN_MS;
      else this.dyingMs = DYING_MS;
      return;
    }
    const points = ENEMY_KINDS[t.kind ?? 'basic'].points;
    this.score += points;
    this.emit('score');
    this.killStreak += 1;
    this.fx(
      { kind: 'popup', x: t.x + TANK / 2, y: FIELD_Y + t.y, text: `+${points}`, color: 'accent' },
      { kind: 'hitstop', ms: t.kind === 'armored' ? 70 : 45 },
      { kind: 'combo', n: this.killStreak },
    );
    this.checkLife();
  }

  private checkLife(): void {
    if (this.score < this.nextLifeAt) return;
    this.nextLifeAt += LIFE_EVERY;
    if (this.lives < MAX_LIVES) {
      this.lives += 1;
      this.emit('bonus');
    }
  }

  // ─── 子弹 ───────────────────────────────────────────────

  private fire(t: Tank): void {
    if (t.coolMs > 0) return;
    t.coolMs = t.fireMs;
    const d = DIRS[t.dir];
    const cx = t.x + TANK / 2 + d.x * TANK / 2;
    const cy = t.y + TANK / 2 + d.y * TANK / 2;
    const player = t.side === 'player';
    this.bullets.push({
      x: cx - BULLET / 2, y: cy - BULLET / 2, dir: t.dir, owner: t.side,
      speed: player ? PLAYER_BULLET : ENEMY_BULLET, dead: false,
    });
    this.sparks(cx, cy, 'flash', 3);
    if (player) this.emit('tick');
  }

  private destroyBase(): void {
    if (!this.baseAlive) return;
    this.baseAlive = false;
    this.boom(BASE_X + TANK / 2, BASE_Y + TANK / 2, 30, 0.115);
    this.shake = 1;
    this.emit('lose');
    this.fx({ kind: 'hitstop', ms: 120 });
    this.dyingMs = DYING_MS;
  }

  private hitTerrain(b: Bullet): boolean {
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + BULLET - 0.01) / CELL);
    const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + BULLET - 0.01) / CELL);
    let hit = false;
    let broke = false;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const v = this.tileAt(cx, cy);
        if (v === Tile.Brick) {
          this.map[cy * COLS + cx] = Tile.Empty;
          hit = broke = true;
        } else if (v === Tile.Steel) {
          hit = true;
          this.sparks(b.x + 2, b.y + 2, 'steel', 4);
        } else if (v === Tile.Base) {
          hit = true;
          if (b.owner === 'enemy') this.destroyBase();
        }
      }
    }
    if (broke) {
      this.sparks(b.x + 2, b.y + 2, 'brick', 8);
      if (b.owner === 'player') this.emit('hit');
    }
    return hit;
  }

  private bulletHitsTank(b: Bullet): boolean {
    for (const t of this.tanks) {
      if (t.dead || t.invulnMs > 0 || t.side === b.owner) continue;
      if (b.x < t.x + TANK && b.x + BULLET > t.x && b.y < t.y + TANK && b.y + BULLET > t.y) {
        this.damageTank(t);
        return true;
      }
    }
    return false;
  }

  private updateBullets(dtMs: number): void {
    for (const b of this.bullets) {
      const d = DIRS[b.dir];
      let remain = b.speed * dtMs;
      // 分小步推进，免得高速子弹穿过一格砖
      while (remain > 0.001 && !b.dead) {
        const s = Math.min(remain, 3);
        b.x += d.x * s;
        b.y += d.y * s;
        if (b.x < -BULLET || b.y < -BULLET || b.x > FIELD_W || b.y > FIELD_H) b.dead = true;
        else if (this.hitTerrain(b) || this.bulletHitsTank(b)) b.dead = true;
        remain -= s;
      }
      if (b.dead) continue;
      // 敌我子弹迎面相撞互相抵消
      const other = this.bullets.find(o => o !== b && !o.dead && o.owner !== b.owner
        && Math.abs(o.x - b.x) < 5 && Math.abs(o.y - b.y) < 5);
      if (other) {
        other.dead = b.dead = true;
        this.sparks(b.x + 2, b.y + 2, 'flash', 5);
      }
    }
    this.bullets = this.bullets.filter(b => !b.dead);
  }

  // ─── 粒子（只是画面，不影响判定） ───────────────────────

  private boom(x: number, y: number, count: number, spread: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.25 + Math.random() * 0.75);
      const life = 250 + Math.random() * 370;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: 620, size: 1 + Math.random() * 1.6, kind: 'fire' });
    }
  }

  private sparks(x: number, y: number, kind: Spark, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.01 + Math.random() * 0.035;
      const life = 100 + Math.random() * 150;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: 250, size: 0.6 + Math.random() * 0.8, kind });
    }
  }

  private updateParts(dtMs: number): void {
    const drag = Math.max(0, 1 - 0.0034 * dtMs);
    for (const p of this.parts) {
      p.x += p.vx * dtMs;
      p.y += p.vy * dtMs;
      p.vx *= drag;
      p.vy *= drag;
      p.life -= dtMs;
    }
    this.parts = this.parts.filter(p => p.life > 0);
  }

  // ─── 绘制 ───────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let x = 0; x <= FIELD_W; x += TANK) ctx.fillRect(x, FIELD_Y, 1, FIELD_H);
    for (let y = 0; y <= FIELD_H; y += TANK) ctx.fillRect(0, FIELD_Y + y, FIELD_W, 1);
    this.drawEnemyCount(ctx, c);

    ctx.save();
    ctx.translate(0, FIELD_Y);
    if (this.shake > 0) {
      const s = this.shake * 2;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    ctx.beginPath();
    ctx.rect(0, 0, FIELD_W, FIELD_H);
    ctx.clip();
    this.drawTerrain(ctx, c);
    this.drawBase(ctx, c);
    for (const t of this.tanks) this.drawTank(ctx, c, t);
    for (const b of this.bullets) {
      ctx.shadowColor = b.owner === 'player' ? c.primary : c.accent;
      ctx.shadowBlur = 6;
      ctx.fillStyle = b.owner === 'player' ? '#fff3c0' : '#ffd0a6';
      ctx.fillRect(b.x, b.y, BULLET, BULLET);
    }
    ctx.shadowBlur = 0;
    this.drawTrees(ctx);
    this.drawParts(ctx, c);
    ctx.restore();

    // 过关横幅由屏幕的反馈层画，这里只画开场的 STAGE n
    if (this.introMs > 0) {
      const label = `STAGE ${this.level}`;
      ctx.fillStyle = 'rgba(13,15,18,0.85)';
      ctx.fillRect(0, ARCADE_HEIGHT / 2 - 10, ARCADE_WIDTH, 20);
      ctx.fillStyle = c.primary;
      ctx.font = '700 11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, ARCADE_WIDTH / 2, ARCADE_HEIGHT / 2 + 0.5);
    }
  }

  /** 顶栏中间：剩余敌军，一个小方块一辆。 */
  private drawEnemyCount(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const n = this.enemiesRemaining;
    const shown = Math.min(n, 14);
    const x0 = ARCADE_WIDTH / 2 - (shown * 5) / 2;
    ctx.fillStyle = c.muted;
    for (let i = 0; i < shown; i++) ctx.fillRect(x0 + i * 5, 5, 3, 5);
  }

  private drawTerrain(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const v = this.map[cy * COLS + cx];
        const x = cx * CELL, y = cy * CELL;
        if (v === Tile.Brick) {
          ctx.fillStyle = c.danger;
          ctx.fillRect(x, y, CELL, CELL);
          // 错缝的砖缝
          ctx.fillStyle = '#5a2a1f';
          ctx.globalAlpha = 0.9;
          ctx.fillRect(x, y + 3, CELL, 1);
          ctx.fillRect(x, y + 7, CELL, 1);
          ctx.fillRect(x + (cy % 2 ? 1 : 5), y, 1, 3);
          ctx.fillRect(x + (cy % 2 ? 5 : 1), y + 4, 1, 3);
          ctx.globalAlpha = 1;
        } else if (v === Tile.Steel) {
          ctx.fillStyle = '#7c8895';
          ctx.fillRect(x, y, CELL, CELL);
          ctx.fillStyle = '#c8d6e2';
          ctx.fillRect(x + 1, y + 1, CELL - 3, CELL - 3);
          ctx.fillStyle = 'rgba(20,28,36,0.5)';
          ctx.fillRect(x + 2, y + 2, CELL - 5, CELL - 5);
        } else if (v === Tile.Water) {
          const w = Math.sin(this.time * 0.0022 + cx * 0.7 + cy * 0.35);
          ctx.fillStyle = '#123a63';
          ctx.fillRect(x, y, CELL, CELL);
          ctx.fillStyle = '#5aaaeb';
          ctx.globalAlpha = 0.35;
          ctx.fillRect(x + 1, y + 2 + w, CELL - 2, 1);
          ctx.fillRect(x + 1, y + 5 - w, CELL - 2, 1);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  private drawTrees(ctx: CanvasRenderingContext2D): void {
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (this.map[cy * COLS + cx] !== Tile.Tree) continue;
        const x = cx * CELL, y = cy * CELL;
        ctx.fillStyle = 'rgba(38,92,52,0.92)';
        ctx.fillRect(x, y, CELL, CELL);
        ctx.fillStyle = 'rgba(86,150,84,0.9)';
        ctx.beginPath();
        ctx.arc(x + 2.5, y + 2.5, 2.1, 0, Math.PI * 2);
        ctx.arc(x + 5.5, y + 4.5, 2.3, 0, Math.PI * 2);
        ctx.arc(x + 3, y + 6, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawBase(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const x = BASE_X, y = BASE_Y;
    ctx.fillStyle = '#1c232c';
    ctx.fillRect(x, y, TANK, TANK);
    if (!this.baseAlive) {
      ctx.strokeStyle = c.danger;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 2.5, y + 13); ctx.lineTo(x + 6.5, y + 5);
      ctx.lineTo(x + 10, y + 13.5); ctx.lineTo(x + 13.5, y + 6);
      ctx.stroke();
      return;
    }
    // 盾牌 + 星
    ctx.fillStyle = c.primary;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + 2);
    ctx.lineTo(x + 14, y + 5.5);
    ctx.lineTo(x + 12.5, y + 14);
    ctx.lineTo(x + 8, y + 15.5);
    ctx.lineTo(x + 3.5, y + 14);
    ctx.lineTo(x + 2, y + 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1c232c';
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 3.8 : 1.6;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const px = x + 8 + Math.cos(a) * r, py = y + 8.5 + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
  }

  private drawTank(ctx: CanvasRenderingContext2D, c: ArcadePalette, t: Tank): void {
    const body = t.side === 'player' ? c.primary
      : t.kind === 'fast' ? c.accent
        : t.kind === 'armored' ? c.ink : c.muted;
    const dark = t.side === 'player' ? '#a3832a' : t.kind === 'fast' ? '#9c4a1c' : t.kind === 'armored' ? c.muted : '#4b5560';
    const rot = { up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[t.dir];

    ctx.save();
    ctx.translate(t.x + TANK / 2, t.y + TANK / 2);
    if (t.invulnMs > 0 && Math.floor(this.time / 70) % 2 === 0) ctx.globalAlpha = 0.35;
    ctx.rotate(rot);
    // 履带
    ctx.fillStyle = dark;
    ctx.fillRect(-8, -7.5, 3.5, 15);
    ctx.fillRect(4.5, -7.5, 3.5, 15);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (let i = -6.5; i < 7; i += 3) {
      ctx.fillRect(-8, i, 3.5, 1);
      ctx.fillRect(4.5, i, 3.5, 1);
    }
    // 车体 + 炮塔
    ctx.fillStyle = body;
    ctx.fillRect(-4.5, -6.5, 9, 13);
    ctx.beginPath();
    ctx.arc(0, 0, 3.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(-2, -2, 1.5, 1.5);
    // 炮管
    ctx.fillStyle = dark;
    ctx.fillRect(-1.3, -9, 2.6, 7.5);
    ctx.restore();

    if (t.flashMs > 0) {
      ctx.globalAlpha = Math.min(1, t.flashMs / 200);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(t.x + 2, t.y + 2, TANK - 4, TANK - 4);
      ctx.globalAlpha = 1;
    }
    // 装甲兵的剩余血量
    if (t.kind === 'armored' && t.hp > 1) {
      ctx.fillStyle = c.accent;
      for (let i = 0; i < t.hp; i++) ctx.fillRect(t.x + 3 + i * 4, t.y - 3, 3, 2);
    }
  }

  private drawParts(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const colors: Record<Spark, string> = { fire: c.accent, brick: '#e08a5c', steel: '#cfe0ee', flash: '#ffe9a6' };
    for (const p of this.parts) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = colors[p.kind];
      const s = p.size * (0.5 + a * 0.8);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }
}
