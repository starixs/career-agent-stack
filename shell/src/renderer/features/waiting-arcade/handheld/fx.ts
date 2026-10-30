// 掌机的公共反馈层：把游戏上报的 Fx 画成粒子、飘字、震屏、闪屏和横幅，
// 并管理命中定格。只是表现，不影响任何判定；随机数用 Math.random 即可。
//
// 反馈按玩家感受分五类，每类有固定的表现手段：
//   打击（命中、破坏）  → burst 碎片 + 小震屏 + 命中定格
//   收获（得分、道具）  → popup 飘字 + 连击音一级级升高
//   成长（升级、过关）  → banner 横幅 + 闪屏 + 升级音
//   失败（丢命、结束）  → 大震屏 + 闪屏，结束面板延后出现，让玩家看清怎么输的
//   输入（按键）        → 实体按键下沉 + 咔哒声（在 HandheldConsole），游戏内即时响应

import { ARCADE_HEIGHT as H, ARCADE_WIDTH as W, type ArcadePalette, type Fx, type FxColor } from '../games';
import type { Ambient } from './themes';

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string }
interface Popup { x: number; y: number; text: string; color: string; life: number }
interface Banner { text: string; sub?: string; life: number }
/** 环境粒子：场景自带的雪、雨、花瓣、星星，一直在飘，不受定格影响。 */
interface Mote { x: number; y: number; vx: number; vy: number; size: number; phase: number }

const POPUP_MS = 750;
const BANNER_MS = 1100;
const MAX_HITSTOP_MS = 120;
const MAX_PARTICLES = 260;
const TAG_MS = 2200;

const AMBIENT_COUNT: Record<Ambient, number> = {
  none: 0, motes: 14, leaves: 10, stars: 22, petals: 12, rain: 26, snow: 24, sand: 18,
};

export class FxLayer {
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private banner: Banner | null = null;
  private flash: { color: string; alpha: number } | null = null;
  private ambient: Ambient = 'none';
  private motes: Mote[] = [];
  /** 换景后顶部短暂显示的场景名。 */
  private tag: { text: string; life: number } | null = null;
  shake = 0;
  /** 剩余定格时间；>0 时屏幕不推进游戏逻辑。 */
  hitstopMs = 0;

  constructor(public palette: ArcadePalette) {}

  private color(c: FxColor | undefined, fallback: string): string {
    if (!c) return fallback;
    return c.startsWith('#') ? c : this.palette[c as keyof ArcadePalette];
  }

  /** 还有东西在动，宿主需要继续逐帧绘制。 */
  get active(): boolean {
    return this.particles.length > 0 || this.popups.length > 0 || this.banner !== null
      || this.flash !== null || this.shake > 0 || this.hitstopMs > 0;
  }

  clear(): void {
    this.particles = [];
    this.popups = [];
    this.banner = null;
    this.flash = null;
    this.shake = 0;
    this.hitstopMs = 0;
    this.tag = null;
    this.setAmbient('none');
  }

  setAmbient(ambient: Ambient): void {
    if (ambient === this.ambient) return;
    this.ambient = ambient;
    this.motes = [];
    // 开场就铺满一屏，而不是从上边慢慢飘下来
    for (let i = 0; i < AMBIENT_COUNT[ambient]; i++) this.motes.push(this.spawnMote(true));
  }

  showTag(text: string): void {
    this.tag = { text, life: TAG_MS };
  }

  private spawnMote(anywhere: boolean): Mote {
    const r = Math.random;
    const m: Mote = { x: r() * W, y: anywhere ? r() * H : -4, vx: 0, vy: 0, size: 1, phase: r() * Math.PI * 2 };
    switch (this.ambient) {
      case 'motes': m.vx = (r() - 0.5) * 0.01; m.vy = -0.004 - r() * 0.006; m.size = 1 + r(); if (!anywhere) m.y = H + 4; break;
      case 'leaves': m.vx = 0.01 + r() * 0.01; m.vy = 0.012 + r() * 0.01; m.size = 2; break;
      case 'stars': m.size = r() < 0.2 ? 2 : 1; break;
      case 'petals': m.vx = 0.008 + r() * 0.012; m.vy = 0.01 + r() * 0.01; m.size = 2; break;
      case 'rain': m.vx = -0.03; m.vy = 0.22 + r() * 0.08; m.size = 4 + r() * 3; break;
      case 'snow': m.vx = (r() - 0.5) * 0.006; m.vy = 0.012 + r() * 0.014; m.size = 1 + Math.round(r()); break;
      case 'sand': m.vx = -0.06 - r() * 0.05; m.vy = 0.004; m.size = 1; if (!anywhere) { m.x = W + 4; m.y = r() * H; } break;
      case 'none': break;
    }
    return m;
  }

  private stepAmbient(dtMs: number): void {
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i];
      m.phase += dtMs * 0.003;
      const sway = this.ambient === 'snow' || this.ambient === 'leaves' || this.ambient === 'petals' ? Math.sin(m.phase) * 0.012 : 0;
      m.x += (m.vx + sway) * dtMs;
      m.y += m.vy * dtMs;
      if (m.y > H + 6 || m.y < -8 || m.x < -8 || m.x > W + 8) this.motes[i] = this.spawnMote(false);
    }
  }

  push(effects: readonly Fx[]): void {
    for (const fx of effects) {
      switch (fx.kind) {
        case 'burst': this.burst(fx.x, fx.y, this.color(fx.color, this.palette.ink), fx.power ?? 0.5); break;
        case 'popup':
          this.popups.push({ x: fx.x, y: fx.y, text: fx.text, color: this.color(fx.color, this.palette.ink), life: POPUP_MS });
          break;
        case 'shake': this.shake = Math.min(1, Math.max(this.shake, fx.power)); break;
        // 定格不叠加，取最长的一次，免得连续命中把游戏卡住
        case 'hitstop': this.hitstopMs = Math.min(MAX_HITSTOP_MS, Math.max(this.hitstopMs, fx.ms)); break;
        case 'flash': this.flash = { color: this.color(fx.color, '#ffffff'), alpha: fx.alpha ?? 0.5 }; break;
        case 'banner': this.banner = { text: fx.text, sub: fx.sub, life: BANNER_MS }; break;
        case 'combo': break; // 只有声音，由屏幕处理
      }
    }
  }

  private burst(x: number, y: number, color: string, power: number): void {
    const p = Math.max(0.1, Math.min(1, power));
    const count = Math.round(5 + p * 22);
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.02 + Math.random() * 0.09) * (0.6 + p);
      const max = 260 + p * 360;
      this.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: max * (0.5 + Math.random() * 0.5), max, size: 1 + Math.random() * (1 + p * 2), color,
      });
    }
  }

  step(dtMs: number): void {
    this.stepAmbient(dtMs);
    if (this.tag) {
      this.tag.life -= dtMs;
      if (this.tag.life <= 0) this.tag = null;
    }
    this.hitstopMs = Math.max(0, this.hitstopMs - dtMs);
    this.shake = Math.max(0, this.shake - dtMs * 0.004);
    if (this.flash) {
      this.flash.alpha -= dtMs * 0.004;
      if (this.flash.alpha <= 0) this.flash = null;
    }
    const drag = Math.max(0, 1 - 0.004 * dtMs);
    for (const p of this.particles) {
      p.x += p.vx * dtMs;
      p.y += p.vy * dtMs;
      p.vx *= drag;
      p.vy = p.vy * drag + 0.00012 * dtMs; // 一点点重力，碎片往下落
      p.life -= dtMs;
    }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const p of this.popups) p.life -= dtMs;
    this.popups = this.popups.filter(p => p.life > 0);
    if (this.banner) {
      this.banner.life -= dtMs;
      if (this.banner.life <= 0) this.banner = null;
    }
  }

  /** 震屏位移；宿主在画游戏前 translate，HUD 不跟着抖。 */
  offset(): [number, number] {
    if (this.shake <= 0) return [0, 0];
    const s = this.shake * this.shake * 5;
    return [(Math.random() - 0.5) * s, (Math.random() - 0.5) * s];
  }

  /** 跟随世界的部分：碎片与飘字。 */
  drawWorld(ctx: CanvasRenderingContext2D): void {
    this.drawAmbient(ctx);
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = Math.min(1, a * 1.6);
      ctx.fillStyle = p.color;
      const s = p.size * (0.4 + a * 0.8);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.font = '800 8px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.palette.bg;
    for (const p of this.popups) {
      const t = 1 - p.life / POPUP_MS;
      const y = p.y - 14 * (1 - (1 - t) ** 2);
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, y);
    }
    ctx.globalAlpha = 1;
  }

  /** 环境粒子画得很淡，盖在游戏上也不挡视线。 */
  private drawAmbient(ctx: CanvasRenderingContext2D): void {
    if (this.motes.length === 0) return;
    const c = this.palette;
    const color = this.ambient === 'petals' ? c.primary
      : this.ambient === 'leaves' ? c.primary
        : this.ambient === 'stars' || this.ambient === 'snow' ? c.ink : c.muted;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    for (const m of this.motes) {
      if (this.ambient === 'stars') {
        ctx.globalAlpha = 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(m.phase));
      } else {
        ctx.globalAlpha = this.ambient === 'rain' ? 0.3 : 0.35;
      }
      if (this.ambient === 'rain') {
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x + m.vx * 30, m.y - m.size);
        ctx.stroke();
      } else if (this.ambient === 'petals' || this.ambient === 'leaves') {
        // 翻转的小片：宽度随相位变化
        const w = 1 + Math.abs(Math.sin(m.phase)) * 2;
        ctx.fillRect(m.x - w / 2, m.y - 1, w, 2);
      } else {
        ctx.fillRect(m.x, m.y, m.size, m.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** 盖在最上面的部分：闪屏、横幅与场景名。 */
  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.flash) {
      ctx.globalAlpha = Math.max(0, Math.min(1, this.flash.alpha));
      ctx.fillStyle = this.flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    this.drawTag(ctx);
    const b = this.banner;
    if (!b) return;
    const age = BANNER_MS - b.life;
    // 弹入：先放大再落定；最后 250ms 淡出
    const pop = age < 160 ? 1.5 - 0.5 * (age / 160) : 1;
    ctx.globalAlpha = b.life < 250 ? b.life / 250 : 1;
    const bandH = b.sub ? 34 : 24;
    ctx.fillStyle = this.palette.ink;
    ctx.fillRect(0, H / 2 - bandH / 2, W, bandH);
    ctx.fillStyle = this.palette.accent;
    ctx.fillRect(0, H / 2 - bandH / 2, W, 2);
    ctx.fillRect(0, H / 2 + bandH / 2 - 2, W, 2);
    ctx.save();
    ctx.translate(W / 2, H / 2 - (b.sub ? 5 : 0));
    ctx.scale(pop, pop);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.palette.bg;
    ctx.font = 'italic 900 14px "Arial Black", "Helvetica Neue", sans-serif';
    ctx.fillText(b.text, 0, 0.5);
    ctx.restore();
    if (b.sub) {
      ctx.textAlign = 'center';
      ctx.fillStyle = this.palette.line;
      ctx.font = '700 8px ui-monospace, "PingFang SC", monospace';
      ctx.fillText(b.sub, W / 2, H / 2 + 10);
    }
    ctx.globalAlpha = 1;
  }

  private drawTag(ctx: CanvasRenderingContext2D): void {
    const tag = this.tag;
    if (!tag) return;
    const age = TAG_MS - tag.life;
    ctx.globalAlpha = Math.min(1, age / 200, tag.life / 400);
    ctx.font = '700 8px "PingFang SC", ui-monospace, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = `— ${tag.text} —`;
    const w = ctx.measureText(text).width + 14;
    // 放在顶部 HUD 下面：底部常是自机站的地方
    const y = 24 - Math.max(0, 1 - age / 200) * 8;
    ctx.fillStyle = this.palette.ink;
    ctx.fillRect(W / 2 - w / 2, y - 6, w, 12);
    ctx.fillStyle = this.palette.bg;
    ctx.fillText(text, W / 2, y + 0.5);
    ctx.globalAlpha = 1;
  }
}
