// 星际射击（横版）：自机常开火，方向键走位；击落带 P 的敌机掉火力胶囊，
// 火力 1~5 级（单发 → 双发 → 三向 → 加追踪弹 → 五向）。B 放清屏炸弹（每命 2 颗）。
// 每 40 秒来一个首领，打掉它进下一关、补满炸弹。挨打掉一级火力和一条命。

import {
  ARCADE_HEIGHT as H,
  ARCADE_WIDTH as W,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

const TOP = 16; // 顶上留给 HUD
const SHIP_SPEED = 0.1;
const FIRE_MS = 140;
const SHOT_SPEED = 0.32;
const START_LIVES = 3;
const START_BOMBS = 2;
const MAX_POWER = 5;
const INVULN_MS = 2000;
const BOSS_EVERY_MS = 40000;
const CHAIN_MS = 900;

export type FoeKind = 'zig' | 'dart' | 'turret' | 'boss';
const FOES: Record<FoeKind, { hp: number; r: number; points: number }> = {
  zig: { hp: 1, r: 5, points: 50 },
  dart: { hp: 2, r: 5, points: 80 },
  turret: { hp: 6, r: 7, points: 200 },
  boss: { hp: 90, r: 16, points: 3000 },
};

export interface Foe {
  x: number; y: number; vx: number; kind: FoeKind; hp: number; maxHp: number;
  t: number; baseY: number; fireCd: number; flashMs: number; carrier: boolean;
}
export interface Shot { x: number; y: number; vx: number; vy: number; homing?: boolean }
export interface Capsule { x: number; y: number }

export class ShooterGame extends EventfulGame implements ArcadeGame {
  score = 0;
  over = false;
  level = 1;
  lives = START_LIVES;
  bombs = START_BOMBS;
  power = 1;
  x = 24;
  y = H / 2 + 8;
  foes: Foe[] = [];
  shots: Shot[] = [];
  enemyShots: Shot[] = [];
  capsules: Capsule[] = [];
  invulnMs = 0;
  /** 距下一个首领的时间；首领在场时不计时。 */
  bossMs = BOSS_EVERY_MS;
  chain = 0;
  private chainMs = 0;
  private fireCd = 0;
  private volley = 0;
  private time = 0;
  private waveCd = 800;
  private bombMs = 0;
  private stars: { x: number; y: number; z: number }[] = [];
  private held = { up: false, down: false, left: false, right: false };

  constructor(private readonly rng: Rng = Math.random) {
    super();
    for (let i = 0; i < 40; i++) this.stars.push({ x: Math.random() * W, y: TOP + Math.random() * (H - TOP), z: 0.3 + Math.random() * 0.7 });
    this.reset();
  }

  get boss(): Foe | undefined {
    return this.foes.find(f => f.kind === 'boss');
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.level = 1;
    this.lives = START_LIVES;
    this.bombs = START_BOMBS;
    this.power = 1;
    this.x = 24;
    this.y = H / 2 + 8;
    this.foes = [];
    this.shots = [];
    this.enemyShots = [];
    this.capsules = [];
    this.invulnMs = INVULN_MS / 2;
    this.bossMs = BOSS_EVERY_MS;
    this.chain = 0;
    this.chainMs = 0;
    this.fireCd = 0;
    this.waveCd = 800;
    this.bombMs = 0;
    this.held = { up: false, down: false, left: false, right: false };
  }

  key(action: ArcadeAction, down: boolean): void {
    if (action in this.held) this.held[action as keyof typeof this.held] = down;
    if (down && (action === 'b' || action === 'r')) this.bomb();
  }

  bomb(): void {
    if (this.bombs <= 0 || this.over) return;
    this.bombs -= 1;
    this.bombMs = 500;
    this.enemyShots = [];
    for (const f of this.foes) this.hitFoe(f, f.kind === 'boss' ? 12 : 99);
    this.fx({ kind: 'flash', color: '#ffffff', alpha: 0.85 }, { kind: 'shake', power: 0.8 }, { kind: 'hitstop', ms: 90 });
    this.emit('big');
  }

  step(dtMs: number): void {
    if (this.over) return;
    this.time += dtMs;
    this.invulnMs = Math.max(0, this.invulnMs - dtMs);
    this.bombMs = Math.max(0, this.bombMs - dtMs);
    this.chainMs -= dtMs;
    if (this.chainMs <= 0) this.chain = 0;
    for (const s of this.stars) {
      s.x -= s.z * 0.06 * dtMs;
      if (s.x < 0) s.x += W;
    }
    this.moveShip(dtMs);
    this.autoFire(dtMs);
    this.spawn(dtMs);
    this.moveFoes(dtMs);
    this.moveShots(dtMs);
    this.moveCapsules(dtMs);
    this.foes = this.foes.filter(f => f.hp > 0 && f.x > -30);
    this.checkHits();
  }

  private moveShip(dtMs: number): void {
    const dx = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
    const dy = (this.held.down ? 1 : 0) - (this.held.up ? 1 : 0);
    const len = Math.hypot(dx, dy) || 1;
    this.x = Math.min(W - 20, Math.max(6, this.x + (dx / len) * SHIP_SPEED * dtMs));
    this.y = Math.min(H - 6, Math.max(TOP + 4, this.y + (dy / len) * SHIP_SPEED * dtMs));
  }

  private autoFire(dtMs: number): void {
    this.fireCd -= dtMs;
    if (this.fireCd > 0) return;
    this.fireCd = FIRE_MS;
    const p = this.power;
    const add = (dy: number, vy = 0) => this.shots.push({ x: this.x + 8, y: this.y + dy, vx: SHOT_SPEED, vy });
    if (p === 1) add(0);
    if (p >= 2 && p !== 3 && p !== 5) { add(-2.5); add(2.5); }
    if (p === 3 || p >= 5) { add(0); add(-2, -0.05); add(2, 0.05); }
    if (p >= 5) { add(-3, -0.1); add(3, 0.1); }
    // 4 级起每隔一轮加两发追踪弹
    this.volley += 1;
    if (p >= 4 && this.volley % 2 === 0) {
      this.shots.push({ x: this.x, y: this.y - 4, vx: 0.2, vy: -0.08, homing: true });
      this.shots.push({ x: this.x, y: this.y + 4, vx: 0.2, vy: 0.08, homing: true });
    }
  }

  private spawn(dtMs: number): void {
    if (this.boss) return;
    this.bossMs -= dtMs;
    if (this.bossMs <= 0) {
      const hp = FOES.boss.hp + (this.level - 1) * 40;
      this.foes.push({ x: W + 20, y: H / 2 + 8, vx: -0.03, kind: 'boss', hp, maxHp: hp, t: 0, baseY: H / 2 + 8, fireCd: 1200, flashMs: 0, carrier: false });
      this.fx({ kind: 'banner', text: 'WARNING', sub: 'BOSS APPROACHING' }, { kind: 'shake', power: 0.3 });
      return;
    }
    this.waveCd -= dtMs;
    if (this.waveCd > 0) return;
    const lv = this.level;
    this.waveCd = Math.max(700, 2100 - lv * 180) + this.rng() * 600;
    const roll = this.rng();
    const y = TOP + 14 + this.rng() * (H - TOP - 28);
    if (roll < 0.45) {
      // 一串正弦摆动的小飞机，最后一架带火力胶囊
      const n = 5;
      for (let i = 0; i < n; i++) this.addFoe('zig', W + 10 + i * 14, y, -0.07 - lv * 0.005, i === n - 1);
    } else if (roll < 0.8) {
      for (let i = 0; i < 3; i++) this.addFoe('dart', W + 10 + i * 20, TOP + 14 + this.rng() * (H - TOP - 28), -0.11 - lv * 0.008, false);
    } else {
      this.addFoe('turret', W + 10, y, -0.035, true);
    }
  }

  private addFoe(kind: FoeKind, x: number, y: number, vx: number, carrier: boolean): void {
    const hp = FOES[kind].hp + (kind === 'turret' ? this.level : 0);
    this.foes.push({ x, y, vx, kind, hp, maxHp: hp, t: 0, baseY: y, fireCd: 900 + this.rng() * 800, flashMs: 0, carrier });
  }

  private moveFoes(dtMs: number): void {
    for (const f of this.foes) {
      f.t += dtMs;
      f.flashMs = Math.max(0, f.flashMs - dtMs);
      if (f.kind === 'boss') {
        // 首领停在右侧上下巡游
        f.x = Math.max(W - 40, f.x + f.vx * dtMs);
        f.y = f.baseY + Math.sin(f.t * 0.0012) * 42;
      } else {
        f.x += f.vx * dtMs;
        if (f.kind === 'zig') f.y = f.baseY + Math.sin(f.t * 0.006) * 14;
        // 飞镖会朝自机方向修正一点
        if (f.kind === 'dart') f.y += Math.sign(this.y - f.y) * 0.02 * dtMs;
      }
      if (f.kind === 'turret' || f.kind === 'boss') {
        f.fireCd -= dtMs;
        if (f.fireCd <= 0 && f.x < W - 4) this.foeFire(f);
      }
    }
  }

  private foeFire(f: Foe): void {
    const aim = Math.atan2(this.y - f.y, this.x - f.x);
    const speed = 0.07 + this.level * 0.005;
    if (f.kind === 'turret') {
      f.fireCd = 1500;
      this.enemyShots.push({ x: f.x, y: f.y, vx: Math.cos(aim) * speed, vy: Math.sin(aim) * speed });
      return;
    }
    // 首领：扇形弹幕和自机狙交替
    const fan = Math.floor(f.t / 1000) % 2 === 0;
    f.fireCd = fan ? 900 : 500;
    const angles = fan ? [-0.5, -0.25, 0, 0.25, 0.5].map(a => Math.PI + a) : [aim - 0.08, aim + 0.08];
    for (const a of angles) this.enemyShots.push({ x: f.x - 10, y: f.y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed });
  }

  private moveShots(dtMs: number): void {
    for (const s of this.shots) {
      if (s.homing) {
        const target = this.foes.reduce<Foe | null>((best, f) =>
          f.x > s.x && (!best || Math.hypot(f.x - s.x, f.y - s.y) < Math.hypot(best.x - s.x, best.y - s.y)) ? f : best, null);
        if (target) s.vy += Math.sign(target.y - s.y) * 0.0012 * dtMs;
        s.vy = Math.max(-0.15, Math.min(0.15, s.vy));
      }
      s.x += s.vx * dtMs;
      s.y += s.vy * dtMs;
    }
    this.shots = this.shots.filter(s => s.x < W + 4 && s.y > TOP - 4 && s.y < H + 4);
    for (const s of this.enemyShots) {
      s.x += s.vx * dtMs;
      s.y += s.vy * dtMs;
    }
    this.enemyShots = this.enemyShots.filter(s => s.x > -4 && s.x < W + 4 && s.y > TOP - 4 && s.y < H + 4);
  }

  private moveCapsules(dtMs: number): void {
    for (const cap of this.capsules) cap.x -= 0.04 * dtMs;
    const keep: Capsule[] = [];
    for (const cap of this.capsules) {
      if (Math.abs(cap.x - this.x) < 9 && Math.abs(cap.y - this.y) < 8) this.powerUp();
      else if (cap.x > -6) keep.push(cap);
    }
    this.capsules = keep;
  }

  private powerUp(): void {
    this.emit('bonus');
    if (this.power < MAX_POWER) {
      this.power += 1;
      this.fx({ kind: 'popup', x: this.x, y: this.y - 8, text: this.power === MAX_POWER ? 'MAX POWER!' : 'POWER UP', color: 'primary' }, { kind: 'flash', color: '#ffffff', alpha: 0.2 });
    } else {
      this.score += 500;
      this.fx({ kind: 'popup', x: this.x, y: this.y - 8, text: '+500', color: 'accent' });
    }
  }

  private hitFoe(f: Foe, dmg: number): void {
    if (f.hp <= 0) return;
    f.hp -= dmg;
    f.flashMs = 60;
    if (f.hp > 0) {
      if (f.kind === 'boss' || f.kind === 'turret') this.emit('hit');
      return;
    }
    this.chain = this.chainMs > 0 ? this.chain + 1 : 1;
    this.chainMs = CHAIN_MS;
    const mult = Math.min(8, this.chain);
    const points = FOES[f.kind].points * mult;
    this.score += points;
    this.emit('score');
    if (f.carrier) this.capsules.push({ x: f.x, y: f.y });
    if (f.kind === 'boss') {
      this.level += 1;
      this.bombs = Math.max(this.bombs, START_BOMBS);
      this.bossMs = BOSS_EVERY_MS;
      this.enemyShots = [];
      this.emit('levelup');
      this.fx(
        { kind: 'burst', x: f.x, y: f.y, color: 'danger', power: 1 },
        { kind: 'burst', x: f.x - 8, y: f.y - 6, color: '#e0a21b', power: 1 },
        { kind: 'burst', x: f.x + 6, y: f.y + 8, color: 'accent', power: 1 },
        { kind: 'shake', power: 1 },
        { kind: 'hitstop', ms: 120 },
        { kind: 'banner', text: 'BOSS DOWN', sub: `+${points}  ·  STAGE ${this.level}` },
      );
      return;
    }
    this.fx({ kind: 'burst', x: f.x, y: f.y, color: f.kind === 'turret' ? 'danger' : 'accent', power: f.kind === 'turret' ? 0.7 : 0.35 });
    if (this.chain >= 2) this.fx({ kind: 'combo', n: this.chain }, { kind: 'popup', x: f.x, y: f.y - 6, text: `×${mult}`, color: 'accent' });
    if (f.kind === 'turret') this.fx({ kind: 'shake', power: 0.3 }, { kind: 'hitstop', ms: 40 });
  }

  private checkHits(): void {
    for (const s of this.shots) {
      for (const f of this.foes) {
        if (f.hp <= 0) continue;
        const r = FOES[f.kind].r;
        if (Math.abs(s.x - f.x) < r + 2 && Math.abs(s.y - f.y) < r + 1.5) {
          this.hitFoe(f, 1);
          s.x = W + 10; // 用掉
          break;
        }
      }
    }
    if (this.invulnMs > 0) return;
    const hitByShot = this.enemyShots.some(s => Math.abs(s.x - this.x) < 3.5 && Math.abs(s.y - this.y) < 3);
    const rammed = this.foes.some(f => f.hp > 0 && Math.abs(f.x - this.x) < FOES[f.kind].r + 3 && Math.abs(f.y - this.y) < FOES[f.kind].r + 2);
    if (!hitByShot && !rammed) return;
    this.lives -= 1;
    this.power = Math.max(1, this.power - 1);
    this.bombs = Math.max(this.bombs, START_BOMBS);
    this.invulnMs = INVULN_MS;
    this.enemyShots = [];
    this.chain = 0;
    this.emit('lose');
    this.fx({ kind: 'burst', x: this.x, y: this.y, color: 'primary', power: 1 });
    if (this.lives <= 0) this.over = true;
  }

  // ─── 绘制 ───────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    for (const s of this.stars) {
      ctx.fillStyle = s.z > 0.7 ? c.muted : c.line;
      ctx.fillRect(s.x, s.y, s.z > 0.7 ? 2 : 1, 1);
    }
    for (const cap of this.capsules) {
      ctx.fillStyle = c.primary;
      ctx.fillRect(cap.x - 5, cap.y - 4, 10, 8);
      ctx.fillStyle = c.bg;
      ctx.font = '800 7px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', cap.x, cap.y + 0.5);
    }
    for (const f of this.foes) this.drawFoe(ctx, c, f);
    ctx.fillStyle = c.primary;
    for (const s of this.shots) ctx.fillRect(s.x - 2, s.y - 0.75, s.homing ? 3 : 5, 1.5);
    ctx.fillStyle = c.accent;
    for (const s of this.enemyShots) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!(this.invulnMs > 0 && Math.floor(this.invulnMs / 80) % 2 === 0)) this.drawShip(ctx, c);
    // 底部：炸弹数与火力
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '700 7px ui-monospace, monospace';
    ctx.fillStyle = c.muted;
    ctx.fillText(`B ${'●'.repeat(this.bombs)}`, 4, H - 5);
    ctx.textAlign = 'right';
    ctx.fillText('PWR', W - 4 - MAX_POWER * 5, H - 5);
    for (let i = 0; i < MAX_POWER; i++) {
      ctx.fillStyle = i < this.power ? c.primary : c.line;
      ctx.fillRect(W - 4 - (MAX_POWER - i) * 5 + 1, H - 8, 3, 6);
    }
    const boss = this.boss;
    if (boss) {
      ctx.fillStyle = c.line;
      ctx.fillRect(60, 15, W - 120, 3);
      ctx.fillStyle = c.danger;
      ctx.fillRect(60, 15, (W - 120) * Math.max(0, boss.hp / boss.maxHp), 3);
    }
  }

  private drawShip(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const { x, y } = this;
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(x + 8, y);
    ctx.lineTo(x - 6, y - 5);
    ctx.lineTo(x - 3, y);
    ctx.lineTo(x - 6, y + 5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = c.primary;
    ctx.fillRect(x - 1, y - 1.5, 4, 3);
    // 尾焰
    ctx.fillStyle = Math.floor(this.time / 60) % 2 ? c.accent : '#e0a21b';
    ctx.fillRect(x - 9, y - 1, 3, 2);
  }

  private drawFoe(ctx: CanvasRenderingContext2D, c: ArcadePalette, f: Foe): void {
    const r = FOES[f.kind].r;
    const color = f.flashMs > 0 ? '#ffffff' : f.kind === 'boss' ? c.danger : f.kind === 'turret' ? c.ink : f.carrier ? c.primary : c.accent;
    ctx.fillStyle = color;
    if (f.kind === 'zig') {
      ctx.beginPath();
      ctx.moveTo(f.x - r, f.y);
      ctx.lineTo(f.x + r, f.y - r);
      ctx.lineTo(f.x + r * 0.4, f.y);
      ctx.lineTo(f.x + r, f.y + r);
      ctx.closePath();
      ctx.fill();
    } else if (f.kind === 'dart') {
      ctx.beginPath();
      ctx.moveTo(f.x - r - 2, f.y);
      ctx.lineTo(f.x + r, f.y - r * 0.7);
      ctx.lineTo(f.x + r, f.y + r * 0.7);
      ctx.closePath();
      ctx.fill();
    } else if (f.kind === 'turret') {
      ctx.fillRect(f.x - r, f.y - r, r * 2, r * 2);
      ctx.fillStyle = c.accent;
      ctx.fillRect(f.x - r - 3, f.y - 1, 4, 2);
    } else {
      ctx.fillRect(f.x - r, f.y - r * 0.8, r * 2, r * 1.6);
      ctx.fillRect(f.x - r - 6, f.y - 4, 8, 8);
      ctx.fillStyle = c.ink;
      ctx.fillRect(f.x - 4, f.y - 4, 8, 8);
      ctx.fillStyle = Math.floor(f.t / 200) % 2 ? c.accent : '#e0a21b';
      ctx.fillRect(f.x - 2, f.y - 2, 4, 4);
    }
  }
}
