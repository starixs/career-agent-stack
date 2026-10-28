// 拒信粉碎机：信件从上面掉下来。拒信要按住 A 开火打碎，落地或砸到你会扣一颗「心态」；
// 「已读不回」灰信更慢更硬；面试邀请和 Offer 要接住，打碎就没了。
// 接到 Offer 进入几秒狂热：三向连射、分数翻倍、屏上拒信一扫而空。
// 每粉碎 20 封进入下一周，信掉得更快更密。
// 基调是解压：拒信碎成纸屑，好消息闪着光，不渲染失败。

import {
  ARCADE_HEIGHT as H,
  ARCADE_WIDTH as W,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

const TOP = 16;
const MACHINE_W = 24;
const MACHINE_H = 10;
const MACHINE_Y = H - MACHINE_H - 3;
const MACHINE_SPEED = 0.15;
const FIRE_MS = 170;
const FEVER_FIRE_MS = 90;
const SHOT_SPEED = 0.26;
const LETTER_W = 14;
const LETTER_H = 10;
const START_LIVES = 3;
const MAX_LIVES = 5;
const FEVER_MS = 6000;
const PER_WEEK = 20;
const MAX_COMBO = 5;

export type LetterKind = 'reject' | 'ghost' | 'invite' | 'offer';
const LETTERS: Record<LetterKind, { hp: number; points: number; speed: number }> = {
  reject: { hp: 1, points: 20, speed: 1 },
  ghost: { hp: 2, points: 40, speed: 0.7 },
  invite: { hp: 1, points: 100, speed: 0.9 },
  offer: { hp: 1, points: 500, speed: 0.8 },
};

export interface Letter { x: number; y: number; kind: LetterKind; hp: number; wobble: number; flashMs: number }
export interface Shot { x: number; y: number; vx: number }

const isGood = (kind: LetterKind) => kind === 'invite' || kind === 'offer';

export class ShredderGame extends EventfulGame implements ArcadeGame {
  score = 0;
  over = false;
  level = 1;
  lives = START_LIVES;
  x = W / 2;
  letters: Letter[] = [];
  shots: Shot[] = [];
  shredded = 0;
  combo = 0;
  feverMs = 0;
  private fireCd = 0;
  private spawnCd = 600;
  private hurtMs = 0;
  private time = 0;
  private held = { left: false, right: false, fire: false };

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  get fallSpeed(): number {
    return 0.026 + (this.level - 1) * 0.004;
  }

  reset(): void {
    this.score = 0;
    this.over = false;
    this.level = 1;
    this.lives = START_LIVES;
    this.x = W / 2;
    this.letters = [];
    this.shots = [];
    this.shredded = 0;
    this.combo = 0;
    this.feverMs = 0;
    this.fireCd = 0;
    this.spawnCd = 600;
    this.hurtMs = 0;
    this.held = { left: false, right: false, fire: false };
  }

  key(action: ArcadeAction, down: boolean): void {
    if (action === 'left') this.held.left = down;
    if (action === 'right') this.held.right = down;
    if (action === 'a' || action === 'b' || action === 'up') this.held.fire = down;
  }

  step(dtMs: number): void {
    if (this.over) return;
    this.time += dtMs;
    this.hurtMs = Math.max(0, this.hurtMs - dtMs);
    if (this.feverMs > 0) {
      this.feverMs = Math.max(0, this.feverMs - dtMs);
      if (this.feverMs === 0) this.fx({ kind: 'popup', x: this.x, y: MACHINE_Y - 8, text: 'FEVER END', color: 'muted' });
    }
    const dir = (this.held.right ? 1 : 0) - (this.held.left ? 1 : 0);
    this.x = Math.min(W - MACHINE_W / 2, Math.max(MACHINE_W / 2, this.x + dir * MACHINE_SPEED * dtMs));
    this.fire(dtMs);
    this.spawn(dtMs);
    this.moveShots(dtMs);
    this.moveLetters(dtMs);
  }

  private fire(dtMs: number): void {
    this.fireCd -= dtMs;
    if (this.fireCd > 0 || !this.held.fire) return;
    const fever = this.feverMs > 0;
    this.fireCd = fever ? FEVER_FIRE_MS : FIRE_MS;
    this.shots.push({ x: this.x, y: MACHINE_Y - 2, vx: 0 });
    if (fever) {
      this.shots.push({ x: this.x - 6, y: MACHINE_Y, vx: -0.03 }, { x: this.x + 6, y: MACHINE_Y, vx: 0.03 });
    }
  }

  private spawn(dtMs: number): void {
    this.spawnCd -= dtMs;
    if (this.spawnCd > 0) return;
    this.spawnCd = Math.max(330, 1050 - (this.level - 1) * 85) * (0.7 + this.rng() * 0.6);
    const roll = this.rng();
    const kind: LetterKind = roll < 0.035 && this.feverMs === 0 ? 'offer'
      : roll < 0.17 ? 'invite'
        : roll < 0.35 && this.level >= 2 ? 'ghost' : 'reject';
    const x = LETTER_W / 2 + 4 + this.rng() * (W - LETTER_W - 8);
    this.letters.push({ x, y: TOP - 4, kind, hp: LETTERS[kind].hp, wobble: this.rng() * Math.PI * 2, flashMs: 0 });
  }

  private moveShots(dtMs: number): void {
    for (const s of this.shots) {
      s.y -= SHOT_SPEED * dtMs;
      s.x += s.vx * dtMs;
      for (const l of this.letters) {
        if (l.hp <= 0 || s.y < 0) continue;
        if (Math.abs(s.x - l.x) < LETTER_W / 2 + 1 && Math.abs(s.y - l.y) < LETTER_H / 2 + 1) {
          s.y = -10;
          this.hitLetter(l);
        }
      }
    }
    this.shots = this.shots.filter(s => s.y > TOP - 4);
  }

  private moveLetters(dtMs: number): void {
    for (const l of this.letters) {
      l.flashMs = Math.max(0, l.flashMs - dtMs);
      l.y += this.fallSpeed * LETTERS[l.kind].speed * dtMs;
      l.wobble += dtMs * 0.004;
      l.x += Math.sin(l.wobble) * 0.012 * dtMs;
      if (l.hp <= 0) continue;
      const touching = l.y + LETTER_H / 2 >= MACHINE_Y && l.y - LETTER_H / 2 <= MACHINE_Y + MACHINE_H
        && Math.abs(l.x - this.x) < (MACHINE_W + LETTER_W) / 2 - 2;
      if (touching) {
        if (isGood(l.kind)) this.catchLetter(l);
        else this.hurt(l);
      } else if (l.y - LETTER_H / 2 > H) {
        l.hp = 0;
        if (!isGood(l.kind)) this.hurt(l);
      }
    }
    this.letters = this.letters.filter(l => l.hp > 0);
  }

  private hitLetter(l: Letter): void {
    if (isGood(l.kind)) {
      // 好消息被打碎了：不扣命，只是可惜
      l.hp = 0;
      this.combo = 0;
      this.emit('tick');
      this.fx(
        { kind: 'burst', x: l.x, y: l.y, color: l.kind === 'offer' ? '#e0a21b' : 'primary', power: 0.3 },
        { kind: 'popup', x: l.x, y: l.y, text: '手滑了…', color: 'muted' },
      );
      return;
    }
    l.hp -= 1;
    l.flashMs = 70;
    if (l.hp > 0) {
      this.emit('hit');
      this.fx({ kind: 'burst', x: l.x, y: l.y + 4, color: 'bg', power: 0.15 });
      return;
    }
    this.shred(l);
  }

  /** 粉碎一封：纸屑四散、连击加分、按周升级。 */
  private shred(l: Letter): void {
    this.combo = Math.min(MAX_COMBO * 4, this.combo + 1);
    const mult = Math.min(MAX_COMBO, 1 + Math.floor(this.combo / 4)) * (this.feverMs > 0 ? 2 : 1);
    const points = LETTERS[l.kind].points * mult;
    this.score += points;
    this.shredded += 1;
    this.emit('score');
    this.fx(
      { kind: 'burst', x: l.x, y: l.y, color: 'bg', power: 0.5 },
      { kind: 'burst', x: l.x, y: l.y, color: l.kind === 'ghost' ? 'muted' : 'accent', power: 0.25 },
      { kind: 'combo', n: this.combo },
    );
    if (mult > 1) this.fx({ kind: 'popup', x: l.x, y: l.y - 4, text: `+${points}`, color: this.feverMs > 0 ? '#e0a21b' : 'ink' });
    if (this.shredded % PER_WEEK === 0) {
      this.level += 1;
      this.emit('levelup');
      this.fx({ kind: 'banner', text: `WEEK ${this.level}`, sub: `第 ${this.level} 周 · 信来得更快了` });
    }
  }

  private catchLetter(l: Letter): void {
    l.hp = 0;
    const points = LETTERS[l.kind].points * (this.feverMs > 0 ? 2 : 1);
    this.score += points;
    if (l.kind === 'invite') {
      this.lives = Math.min(MAX_LIVES, this.lives + 1);
      this.emit('bonus');
      this.fx(
        { kind: 'popup', x: l.x, y: MACHINE_Y - 8, text: `面试邀请 +${points}`, color: 'primary' },
        { kind: 'burst', x: l.x, y: MACHINE_Y, color: 'primary', power: 0.5 },
      );
      return;
    }
    this.feverMs = FEVER_MS;
    this.emit('big');
    // 狂热开场：屏上所有拒信当场粉碎
    for (const other of this.letters) {
      if (other.hp > 0 && !isGood(other.kind)) {
        other.hp = 0;
        this.shred(other);
      }
    }
    this.fx(
      { kind: 'banner', text: 'OFFER!', sub: `+${points}  ·  FEVER ×2` },
      { kind: 'flash', color: '#fff6d0', alpha: 0.7 },
      { kind: 'shake', power: 0.6 },
      { kind: 'hitstop', ms: 100 },
      { kind: 'burst', x: l.x, y: MACHINE_Y, color: '#e0a21b', power: 1 },
    );
  }

  private hurt(l: Letter): void {
    l.hp = 0;
    this.combo = 0;
    if (this.hurtMs > 0) return;
    this.hurtMs = 600;
    this.lives -= 1;
    this.emit('lose');
    this.fx({ kind: 'burst', x: l.x, y: Math.min(l.y, H - 4), color: 'accent', power: 0.4 });
    if (this.lives <= 0) this.over = true;
  }

  // ─── 绘制 ───────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const fever = this.feverMs > 0;
    ctx.fillStyle = fever ? '#e9dfb4' : c.bg;
    ctx.fillRect(0, 0, W, H);
    if (fever) {
      // 狂热时背景斜纹流动
      ctx.fillStyle = 'rgba(224,162,27,0.18)';
      const off = (this.time * 0.05) % 24;
      for (let x = -H; x < W; x += 24) {
        ctx.beginPath();
        ctx.moveTo(x + off, H);
        ctx.lineTo(x + off + 10, H);
        ctx.lineTo(x + off + 10 + H, 0);
        ctx.lineTo(x + off + H, 0);
        ctx.fill();
      }
    }
    // 地面线：拒信落到这里就算没拦住
    ctx.fillStyle = c.line;
    ctx.fillRect(0, H - 2, W, 2);
    for (const l of this.letters) this.drawLetter(ctx, c, l);
    ctx.fillStyle = fever ? '#c7860f' : c.ink;
    for (const s of this.shots) ctx.fillRect(s.x - 1, s.y - 3, 2, 5);
    this.drawMachine(ctx, c);
    if (fever) {
      ctx.fillStyle = '#c7860f';
      ctx.fillRect(0, 16, W * (this.feverMs / FEVER_MS), 2);
    }
    if (this.combo >= 4) {
      ctx.fillStyle = c.accent;
      ctx.font = '800 8px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`COMBO ${this.combo}  ×${Math.min(MAX_COMBO, 1 + Math.floor(this.combo / 4))}`, 4, 24);
    }
  }

  private drawMachine(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    if (this.hurtMs > 0 && Math.floor(this.hurtMs / 80) % 2 === 0) return;
    const x = this.x - MACHINE_W / 2, y = MACHINE_Y;
    ctx.fillStyle = c.ink;
    ctx.fillRect(x, y + 2, MACHINE_W, MACHINE_H - 2);
    // 进纸口
    ctx.fillStyle = this.feverMs > 0 ? '#e0a21b' : c.primary;
    ctx.fillRect(x + 3, y, MACHINE_W - 6, 3);
    ctx.fillStyle = c.bg;
    ctx.fillRect(x + 5, y + 1, MACHINE_W - 10, 1);
    // 底下吐纸屑的齿
    ctx.fillStyle = c.muted;
    for (let i = 0; i < 5; i++) ctx.fillRect(x + 3 + i * 4.5, y + MACHINE_H, 2, 2);
  }

  private drawLetter(ctx: CanvasRenderingContext2D, c: ArcadePalette, l: Letter): void {
    const x = l.x - LETTER_W / 2, y = l.y - LETTER_H / 2;
    const paper = l.flashMs > 0 ? '#ffffff'
      : l.kind === 'offer' ? '#e0a21b'
        : l.kind === 'invite' ? '#dfe8f7'
          : l.kind === 'ghost' ? c.line : '#f4f1e6';
    if (l.kind === 'offer') {
      // 一圈光晕
      ctx.fillStyle = 'rgba(224,162,27,0.3)';
      const glow = 3 + Math.sin(this.time * 0.01) * 1.5;
      ctx.fillRect(x - glow, y - glow, LETTER_W + glow * 2, LETTER_H + glow * 2);
    }
    ctx.fillStyle = paper;
    ctx.fillRect(x, y, LETTER_W, LETTER_H);
    ctx.strokeStyle = l.kind === 'ghost' ? c.muted : c.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, LETTER_W - 1, LETTER_H - 1);
    // 信封折线
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 0.5);
    ctx.lineTo(l.x, y + LETTER_H * 0.55);
    ctx.lineTo(x + LETTER_W - 0.5, y + 0.5);
    ctx.stroke();
    // 封口印：拒信 ✕、已读不回 …、面试邀请 ✓、Offer ★
    const sx = l.x, sy = y + LETTER_H - 3;
    if (l.kind === 'reject') {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(sx - 2, sy - 2); ctx.lineTo(sx + 2, sy + 2);
      ctx.moveTo(sx + 2, sy - 2); ctx.lineTo(sx - 2, sy + 2);
      ctx.stroke();
    } else if (l.kind === 'ghost') {
      ctx.fillStyle = c.muted;
      for (let i = -1; i <= 1; i++) ctx.fillRect(sx + i * 2.5 - 0.5, sy, 1.2, 1.2);
    } else if (l.kind === 'invite') {
      ctx.strokeStyle = c.primary;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(sx - 2.5, sy); ctx.lineTo(sx - 0.5, sy + 2); ctx.lineTo(sx + 3, sy - 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#fff6d0';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 3 : 1.3;
        const a = (Math.PI / 5) * i - Math.PI / 2;
        if (i === 0) ctx.moveTo(sx + Math.cos(a) * r, sy - 1 + Math.sin(a) * r);
        else ctx.lineTo(sx + Math.cos(a) * r, sy - 1 + Math.sin(a) * r);
      }
      ctx.fill();
    }
  }
}
