// 幸存者：角色自动朝最近的敌人开火，玩家只管走位。敌人从四边涌来，
// 打死掉经验宝石，攒满升级，每级从三张强化卡里挑一张（射速、散射、穿透、
// 护身球、冲击波……）。前几级几秒一升，越往后怪越多越硬。

import {
  ARCADE_HEIGHT as H,
  ARCADE_WIDTH as W,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

const PLAYER_R = 4;
const BASE_SPEED = 0.07; // px / ms
const MAX_HP = 5;
const HURT_INVULN_MS = 900;
const BULLET_SPEED = 0.2;
const BULLET_LIFE_MS = 900;
const BASE_FIRE_MS = 560;
const ORBIT_R = 20;
const ORBIT_HIT_MS = 380;
const NOVA_MS = 2600;
const GEM_PULL = 0.16;
/** 宝石放久了自己飞过来：升级节奏不该卡在「懒得去捡」上。 */
const GEM_HOMING_MS = 4000;
const MAX_ENEMIES = 90;

export type EnemyKind = 'blob' | 'runner' | 'brute';
const ENEMIES: Record<EnemyKind, { r: number; speed: number; hp: number; points: number; xp: number }> = {
  blob: { r: 4, speed: 0.022, hp: 1, points: 10, xp: 1 },
  runner: { r: 3.5, speed: 0.042, hp: 1, points: 15, xp: 1 },
  brute: { r: 7, speed: 0.016, hp: 7, points: 60, xp: 5 },
};

export type UpgradeId = 'rate' | 'multi' | 'pierce' | 'damage' | 'orbit' | 'nova' | 'speed' | 'magnet' | 'heal';
export const UPGRADES: Record<UpgradeId, { name: string; desc: string; max: number }> = {
  rate: { name: '连射', desc: '射速 +30%', max: 5 },
  multi: { name: '散射', desc: '多一条弹道', max: 4 },
  pierce: { name: '穿透', desc: '子弹多穿一个', max: 3 },
  damage: { name: '重弹', desc: '伤害 +1', max: 4 },
  orbit: { name: '护身球', desc: '多一颗绕身球', max: 4 },
  nova: { name: '冲击波', desc: '定时震开一圈', max: 4 },
  speed: { name: '疾行', desc: '移速 +15%', max: 3 },
  magnet: { name: '磁铁', desc: '吸经验更远', max: 3 },
  heal: { name: '回血', desc: '回复 2 颗心', max: 99 },
};

export interface Enemy { x: number; y: number; kind: EnemyKind; hp: number; flashMs: number; orbitCd: number }
export interface Shot { x: number; y: number; vx: number; vy: number; life: number; pierce: number }
export interface Gem { x: number; y: number; xp: number; age?: number }

export class SurvivorGame extends EventfulGame implements ArcadeGame {
  score = 0;
  over = false;
  level = 1;
  lives = 3;
  x = W / 2;
  y = H / 2 + 6;
  xp = 0;
  /** 已经活了多久，决定刷怪强度。 */
  timeMs = 0;
  enemies: Enemy[] = [];
  shots: Shot[] = [];
  gems: Gem[] = [];
  ups: Record<UpgradeId, number> = { rate: 0, multi: 0, pierce: 0, damage: 0, orbit: 0, nova: 0, speed: 0, magnet: 0, heal: 0 };
  /** 升级时给的三张卡；非 null 时世界暂停等玩家挑。 */
  choices: UpgradeId[] | null = null;
  cursor = 0;
  private pendingLevels = 0;
  private hurtMs = 0;
  private fireCd = 0;
  private spawnCd = 0;
  private novaCd = NOVA_MS;
  private novaRing = 0;
  private orbitAngle = 0;
  private held = { up: false, down: false, left: false, right: false };
  private facing = { x: 1, y: 0 };

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  get xpNeed(): number {
    return 3 + (this.level - 1) * 3;
  }

  get speed(): number {
    return BASE_SPEED * (1 + this.ups.speed * 0.15);
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.level = 1;
    this.lives = 3;
    this.x = W / 2;
    this.y = H / 2 + 6;
    this.xp = 0;
    this.timeMs = 0;
    this.enemies = [];
    this.shots = [];
    this.gems = [];
    this.ups = { rate: 0, multi: 0, pierce: 0, damage: 0, orbit: 0, nova: 0, speed: 0, magnet: 0, heal: 0 };
    this.choices = null;
    this.pendingLevels = 0;
    this.hurtMs = 0;
    this.fireCd = 300;
    this.spawnCd = 400;
    this.novaCd = NOVA_MS;
    this.novaRing = 0;
    this.held = { up: false, down: false, left: false, right: false };
  }

  key(action: ArcadeAction, down: boolean): void {
    if (this.choices) {
      if (!down) return;
      if (action === 'left' || action === 'up') this.moveCursor(-1);
      else if (action === 'right' || action === 'down') this.moveCursor(1);
      else if (action === 'a' || action === 'b') this.pick(this.cursor);
      return;
    }
    if (action in this.held) this.held[action as keyof typeof this.held] = down;
  }

  private moveCursor(d: number): void {
    const n = this.choices?.length ?? 1;
    this.cursor = (this.cursor + d + n) % n;
    this.emit('tick');
  }

  pick(index: number): void {
    const id = this.choices?.[index];
    if (!id) return;
    this.ups[id] += 1;
    if (id === 'heal') this.lives = Math.min(MAX_HP, this.lives + 2);
    this.choices = null;
    this.emit('bonus');
    this.fx({ kind: 'popup', x: this.x, y: this.y - 8, text: UPGRADES[id].name, color: 'primary' });
    if (this.pendingLevels > 0) {
      this.pendingLevels -= 1;
      this.offerChoices();
    } else {
      // 刚选完别让玩家被贴脸的怪打到
      this.hurtMs = Math.max(this.hurtMs, 500);
    }
    // 选卡期间松开的方向键收不到，回到世界时全部当作松开
    this.held = { up: false, down: false, left: false, right: false };
  }

  private offerChoices(): void {
    const pool = (Object.keys(UPGRADES) as UpgradeId[])
      .filter(id => this.ups[id] < UPGRADES[id].max && (id !== 'heal' || this.lives < MAX_HP));
    const picks: UpgradeId[] = [];
    while (picks.length < 3 && pool.length > 0) {
      picks.push(...pool.splice(Math.floor(this.rng() * pool.length), 1));
    }
    this.choices = picks.length ? picks : ['heal'];
    this.cursor = 0;
  }

  step(dtMs: number): void {
    if (this.over || this.choices) return;
    this.timeMs += dtMs;
    this.hurtMs = Math.max(0, this.hurtMs - dtMs);
    this.movePlayer(dtMs);
    this.spawn(dtMs);
    this.moveEnemies(dtMs);
    this.fire(dtMs);
    this.moveShots(dtMs);
    this.spinOrbs(dtMs);
    this.pulseNova(dtMs);
    this.collectGems(dtMs);
    this.enemies = this.enemies.filter(e => e.hp > 0);
    this.touchEnemies();
  }

  private movePlayer(dtMs: number): void {
    const dx = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
    const dy = (this.held.down ? 1 : 0) - (this.held.up ? 1 : 0);
    if (!dx && !dy) return;
    const len = Math.hypot(dx, dy);
    this.facing = { x: dx / len, y: dy / len };
    const s = this.speed * dtMs;
    this.x = Math.min(W - PLAYER_R, Math.max(PLAYER_R, this.x + (dx / len) * s));
    this.y = Math.min(H - PLAYER_R - 3, Math.max(PLAYER_R + 14, this.y + (dy / len) * s));
  }

  private spawn(dtMs: number): void {
    const t = this.timeMs / 1000;
    this.spawnCd -= dtMs;
    if (this.spawnCd > 0 || this.enemies.length >= MAX_ENEMIES) return;
    this.spawnCd = Math.max(140, 900 - t * 9);
    // 每过 30 秒一波包围圈
    const wave = Math.floor(t / 30) > Math.floor((t - dtMs / 1000) / 30) && t > 5;
    const count = wave ? 14 + Math.floor(t / 30) * 4 : 1 + Math.floor(t / 25);
    for (let i = 0; i < count; i++) {
      const roll = this.rng();
      const kind: EnemyKind = t > 40 && roll < 0.08 + t / 2000 ? 'brute' : t > 15 && roll < 0.4 ? 'runner' : 'blob';
      const [x, y] = wave ? this.ringPoint(i / count) : this.edgePoint();
      const hp = ENEMIES[kind].hp + Math.floor(t / 50);
      this.enemies.push({ x, y, kind, hp, flashMs: 0, orbitCd: 0 });
    }
    if (wave) this.fx({ kind: 'banner', text: 'WAVE!', sub: '包围圈来了' });
  }

  private edgePoint(): [number, number] {
    const side = Math.floor(this.rng() * 4);
    const r = this.rng();
    if (side === 0) return [r * W, 8];
    if (side === 1) return [r * W, H + 6];
    if (side === 2) return [-6, 14 + r * (H - 14)];
    return [W + 6, 14 + r * (H - 14)];
  }

  private ringPoint(f: number): [number, number] {
    const a = f * Math.PI * 2;
    return [this.x + Math.cos(a) * 150, this.y + Math.sin(a) * 110];
  }

  private moveEnemies(dtMs: number): void {
    for (const e of this.enemies) {
      e.flashMs = Math.max(0, e.flashMs - dtMs);
      e.orbitCd = Math.max(0, e.orbitCd - dtMs);
      const dx = this.x - e.x, dy = this.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      const s = ENEMIES[e.kind].speed * (1 + this.timeMs / 240000) * dtMs;
      e.x += (dx / d) * s;
      e.y += (dy / d) * s;
    }
  }

  private nearest(range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestD = range;
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private fire(dtMs: number): void {
    this.fireCd -= dtMs;
    if (this.fireCd > 0) return;
    const target = this.nearest(150);
    if (!target) return;
    this.fireCd = BASE_FIRE_MS / (1 + this.ups.rate * 0.3);
    const base = Math.atan2(target.y - this.y, target.x - this.x);
    const n = 1 + this.ups.multi;
    for (let i = 0; i < n; i++) {
      const a = base + (i - (n - 1) / 2) * 0.22;
      this.shots.push({
        x: this.x, y: this.y, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
        life: BULLET_LIFE_MS, pierce: this.ups.pierce,
      });
    }
  }

  private moveShots(dtMs: number): void {
    const dmg = 1 + this.ups.damage;
    for (const s of this.shots) {
      s.x += s.vx * dtMs;
      s.y += s.vy * dtMs;
      s.life -= dtMs;
      for (const e of this.enemies) {
        if (e.hp <= 0 || s.life <= 0) continue;
        if (Math.hypot(e.x - s.x, e.y - s.y) > ENEMIES[e.kind].r + 1.5) continue;
        this.damage(e, dmg);
        if (s.pierce > 0) s.pierce -= 1;
        else s.life = 0;
      }
    }
    this.shots = this.shots.filter(s => s.life > 0 && s.x > -4 && s.x < W + 4 && s.y > -4 && s.y < H + 4);
  }

  orbPositions(): { x: number; y: number }[] {
    const n = this.ups.orbit;
    return Array.from({ length: n }, (_, i) => {
      const a = this.orbitAngle + (i / n) * Math.PI * 2;
      return { x: this.x + Math.cos(a) * ORBIT_R, y: this.y + Math.sin(a) * ORBIT_R };
    });
  }

  private spinOrbs(dtMs: number): void {
    if (!this.ups.orbit) return;
    this.orbitAngle += dtMs * 0.0045;
    for (const orb of this.orbPositions()) {
      for (const e of this.enemies) {
        if (e.hp <= 0 || e.orbitCd > 0) continue;
        if (Math.hypot(e.x - orb.x, e.y - orb.y) > ENEMIES[e.kind].r + 3) continue;
        e.orbitCd = ORBIT_HIT_MS;
        this.damage(e, 1 + Math.floor(this.ups.damage / 2));
      }
    }
  }

  get novaRadius(): number {
    return 26 + this.ups.nova * 10;
  }

  private pulseNova(dtMs: number): void {
    this.novaRing = Math.max(0, this.novaRing - dtMs);
    if (!this.ups.nova) return;
    this.novaCd -= dtMs;
    if (this.novaCd > 0) return;
    this.novaCd = NOVA_MS - this.ups.nova * 250;
    this.novaRing = 260;
    let hit = 0;
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (e.hp <= 0 || d > this.novaRadius) continue;
      hit += 1;
      this.damage(e, 2 + this.ups.damage);
      // 震开一段
      const push = 14 / (d || 1);
      e.x += (e.x - this.x) * push;
      e.y += (e.y - this.y) * push;
    }
    this.fx({ kind: 'shake', power: hit > 4 ? 0.35 : 0.15 });
    this.emit('clear');
  }

  private damage(e: Enemy, dmg: number): void {
    e.hp -= dmg;
    e.flashMs = 80;
    if (e.hp > 0) {
      this.emit('hit');
      return;
    }
    const spec = ENEMIES[e.kind];
    this.score += spec.points;
    this.gems.push({ x: e.x, y: e.y, xp: spec.xp });
    this.emit('score');
    const big = e.kind === 'brute';
    this.fx({ kind: 'burst', x: e.x, y: e.y, color: big ? 'danger' : 'accent', power: big ? 0.9 : 0.3 });
    if (big) this.fx({ kind: 'hitstop', ms: 60 }, { kind: 'shake', power: 0.4 }, { kind: 'popup', x: e.x, y: e.y - 6, text: `+${spec.points}`, color: 'accent' });
  }

  private collectGems(dtMs: number): void {
    const reach = 34 + this.ups.magnet * 18;
    let got = 0;
    for (const g of this.gems) {
      g.age = (g.age ?? 0) + dtMs;
      const dx = this.x - g.x, dy = this.y - g.y;
      const d = Math.hypot(dx, dy);
      if (d < 5) {
        got += g.xp;
        g.xp = 0;
      } else if (d < reach || g.age > GEM_HOMING_MS) {
        const s = Math.min(d, GEM_PULL * dtMs);
        g.x += (dx / d) * s;
        g.y += (dy / d) * s;
      }
    }
    this.gems = this.gems.filter(g => g.xp > 0);
    if (!got) return;
    this.xp += got;
    this.emit('tick');
    let levels = 0;
    while (this.xp >= this.xpNeed) {
      this.xp -= this.xpNeed;
      this.level += 1;
      levels += 1;
    }
    if (!levels) return;
    this.emit('levelup');
    // 选卡面板本身就是升级的庆祝，不再叠横幅
    this.fx({ kind: 'burst', x: this.x, y: this.y, color: 'primary', power: 0.8 });
    this.pendingLevels += levels - 1;
    this.offerChoices();
  }

  private touchEnemies(): void {
    if (this.hurtMs > 0) return;
    const hit = this.enemies.find(e => Math.hypot(e.x - this.x, e.y - this.y) < ENEMIES[e.kind].r + PLAYER_R - 1);
    if (!hit) return;
    this.lives -= 1;
    this.hurtMs = HURT_INVULN_MS;
    this.emit('lose');
    // 挨打时把周围的怪推开一点，给喘息
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - this.x, e.y - this.y);
      if (d < 30) {
        e.x += ((e.x - this.x) / (d || 1)) * 12;
        e.y += ((e.y - this.y) / (d || 1)) * 12;
      }
    }
    if (this.lives <= 0) this.over = true;
  }

  // ─── 绘制 ───────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    // 地面小点阵，给移动一点参照
    ctx.fillStyle = c.line;
    for (let gx = 6; gx < W; gx += 16) for (let gy = 20; gy < H; gy += 16) ctx.fillRect(gx, gy, 1, 1);

    if (this.novaRing > 0) {
      const t = 1 - this.novaRing / 260;
      ctx.strokeStyle = c.primary;
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.novaRadius * (0.3 + 0.7 * t), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const g of this.gems) {
      ctx.fillStyle = g.xp > 1 ? '#e0a21b' : c.primary;
      ctx.beginPath();
      ctx.moveTo(g.x, g.y - 2.5);
      ctx.lineTo(g.x + 2, g.y);
      ctx.lineTo(g.x, g.y + 2.5);
      ctx.lineTo(g.x - 2, g.y);
      ctx.fill();
    }
    for (const e of this.enemies) this.drawEnemy(ctx, c, e);
    ctx.fillStyle = c.ink;
    for (const s of this.shots) ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    for (const orb of this.orbPositions()) {
      ctx.fillStyle = c.primary;
      ctx.beginPath();
      ctx.arc(orb.x, orb.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawPlayer(ctx, c);
    // 经验条
    ctx.fillStyle = c.line;
    ctx.fillRect(0, H - 3, W, 3);
    ctx.fillStyle = c.primary;
    ctx.fillRect(0, H - 3, W * Math.min(1, this.xp / this.xpNeed), 3);
    if (this.choices) this.drawChoices(ctx, c);
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    if (this.hurtMs > 0 && Math.floor(this.hurtMs / 80) % 2 === 0) return;
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.arc(this.x, this.y, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.bg;
    ctx.fillRect(this.x + this.facing.x * 1.5 - 1, this.y + this.facing.y * 1.5 - 1, 2, 2);
  }

  private drawEnemy(ctx: CanvasRenderingContext2D, c: ArcadePalette, e: Enemy): void {
    const r = ENEMIES[e.kind].r;
    ctx.fillStyle = e.flashMs > 0 ? '#ffffff' : e.kind === 'brute' ? c.danger : e.kind === 'runner' ? c.muted : c.accent;
    if (e.kind === 'runner') {
      const a = Math.atan2(this.y - e.y, this.x - e.x);
      ctx.beginPath();
      ctx.moveTo(e.x + Math.cos(a) * r * 1.3, e.y + Math.sin(a) * r * 1.3);
      ctx.lineTo(e.x + Math.cos(a + 2.4) * r, e.y + Math.sin(a + 2.4) * r);
      ctx.lineTo(e.x + Math.cos(a - 2.4) * r, e.y + Math.sin(a - 2.4) * r);
      ctx.fill();
      return;
    }
    if (e.kind === 'brute') {
      ctx.fillRect(e.x - r, e.y - r, r * 2, r * 2);
    } else {
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = c.bg;
    ctx.fillRect(e.x - r * 0.5, e.y - 1, 1.5, 1.5);
    ctx.fillRect(e.x + r * 0.5 - 1.5, e.y - 1, 1.5, 1.5);
  }

  private drawChoices(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const choices = this.choices ?? [];
    ctx.fillStyle = 'rgba(28,34,48,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = c.bg;
    ctx.font = 'italic 900 12px "Arial Black", "Helvetica Neue", sans-serif';
    ctx.fillText(`LEVEL ${this.level}`, W / 2, 30);
    const cw = 68, ch = 70, gap = 8;
    const x0 = (W - (cw * choices.length + gap * (choices.length - 1))) / 2;
    choices.forEach((id, i) => {
      const x = x0 + i * (cw + gap), y = 46;
      const active = i === this.cursor;
      ctx.fillStyle = active ? c.bg : c.line;
      ctx.fillRect(x, active ? y - 3 : y, cw, ch);
      if (active) {
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y - 2, cw - 2, ch - 2);
      }
      const up = UPGRADES[id];
      ctx.fillStyle = c.ink;
      ctx.font = '700 12px "PingFang SC", "Helvetica Neue", sans-serif';
      ctx.fillText(up.name, x + cw / 2, y + 20);
      ctx.fillStyle = c.muted;
      ctx.font = '500 8px "PingFang SC", "Helvetica Neue", sans-serif';
      ctx.fillText(up.desc, x + cw / 2, y + 40);
      if (id !== 'heal') {
        // 当前等级小格
        for (let k = 0; k < up.max; k++) {
          ctx.fillStyle = k < this.ups[id] ? c.primary : k === this.ups[id] ? c.accent : c.line;
          ctx.fillRect(x + cw / 2 - (up.max * 6) / 2 + k * 6, y + 54, 4, 4);
        }
      }
    });
    ctx.fillStyle = c.line;
    ctx.font = '500 8px "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.fillText('← → 选择   A 确定', W / 2, H - 14);
  }
}
