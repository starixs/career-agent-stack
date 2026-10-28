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

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string }
interface Popup { x: number; y: number; text: string; color: string; life: number }
interface Banner { text: string; sub?: string; life: number }

const POPUP_MS = 750;
const BANNER_MS = 1100;
const MAX_HITSTOP_MS = 120;
const MAX_PARTICLES = 260;

export class FxLayer {
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private banner: Banner | null = null;
  private flash: { color: string; alpha: number } | null = null;
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

  /** 盖在最上面的部分：闪屏与横幅。 */
  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.flash) {
      ctx.globalAlpha = Math.max(0, Math.min(1, this.flash.alpha));
      ctx.fillStyle = this.flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
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
}
