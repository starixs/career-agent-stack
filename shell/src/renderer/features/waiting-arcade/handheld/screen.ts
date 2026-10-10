// 掌机屏幕状态机：开机 → 选游戏菜单 → 游戏中 ⇄ 暂停 → 结束。
// 纯逻辑 + canvas 绘制，不碰 React / DOM 事件，可在 node 单测里直接驱动。

import {
  ARCADE_GAME_IDS,
  ARCADE_HEIGHT as H,
  ARCADE_WIDTH as W,
  createArcadeGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadeGameId,
  type ArcadePalette,
} from '../games';

export type HandheldButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'start' | 'select' | 'l' | 'r';
export type ScreenMode = 'boot' | 'menu' | 'playing' | 'paused' | 'over';
export type ScreenSound = 'boot' | 'move' | 'confirm' | 'score' | 'pause' | 'over';

/** 反射式彩色 LCD 的偏灰配色：掌机是实体物件，不跟随 App 主题。 */
export const LCD_PALETTE: ArcadePalette = {
  bg: '#cdd3bf',
  ink: '#1c2230',
  muted: '#5f6857',
  line: '#a4ad94',
  primary: '#2c5aa8',
  accent: '#c63f36',
  danger: '#b8501c',
};

export const BOOT_MS = 1900;

export interface ScreenText {
  wordmark: string;
  menuTitle: string;
  menuHint: string;
  best: string;
  paused: string;
  pausedHint: string;
  gameOver: string;
  overHint: string;
  games: Record<ArcadeGameId, string>;
}

export interface BestScoreStore {
  read(id: ArcadeGameId): number;
  write(id: ArcadeGameId, score: number): void;
}

interface ScreenOptions {
  text: ScreenText;
  best: BestScoreStore;
  initialGame?: ArcadeGameId;
  onSound?: (sound: ScreenSound) => void;
  onGameChange?: (id: ArcadeGameId) => void;
}

const DPAD: Partial<Record<HandheldButton, ArcadeAction>> = { up: 'up', down: 'down', left: 'left', right: 'right' };

function toAction(button: HandheldButton): ArcadeAction | null {
  if (button === 'a' || button === 'b') return 'action';
  return DPAD[button] ?? null;
}

export class HandheldScreen {
  mode: ScreenMode = 'boot';
  bootMs = 0;
  menuIndex: number;
  game: ArcadeGame | null = null;
  /** 暂停时屏幕上显示的外部原因（如「AI 回复好了」），优先于普通暂停文案。 */
  notice: string | null = null;
  private held = new Set<HandheldButton>();
  private lastScoreMark = 0;
  private readonly bests = new Map<ArcadeGameId, number>();

  constructor(private readonly opts: ScreenOptions) {
    this.menuIndex = Math.max(0, ARCADE_GAME_IDS.indexOf(opts.initialGame ?? 'snake'));
    for (const id of ARCADE_GAME_IDS) this.bests.set(id, opts.best.read(id));
  }

  get gameId(): ArcadeGameId {
    return ARCADE_GAME_IDS[this.menuIndex];
  }

  get score(): number {
    return this.game?.score ?? 0;
  }

  best(id: ArcadeGameId = this.gameId): number {
    return this.bests.get(id) ?? 0;
  }

  /** 需要逐帧推进（开机动画 / 游戏中）时宿主才跑 rAF。 */
  get animating(): boolean {
    return this.mode === 'boot' || this.mode === 'playing';
  }

  press(button: HandheldButton): void {
    switch (this.mode) {
      case 'boot':
        if (button === 'a' || button === 'start') this.toMenu('confirm');
        return;
      case 'menu':
        if (button === 'up' || button === 'l' || button === 'left') this.moveMenu(-1);
        else if (button === 'down' || button === 'r' || button === 'right') this.moveMenu(1);
        else if (button === 'a' || button === 'start') this.startGame();
        return;
      case 'playing': {
        if (button === 'start') {
          this.pause();
          return;
        }
        if (button === 'select') {
          this.toMenu('move');
          return;
        }
        const action = toAction(button);
        if (action && this.game) {
          this.held.add(button);
          this.game.key(action, true);
        }
        return;
      }
      case 'paused':
        if (button === 'start' || button === 'a') this.resume();
        else if (button === 'select') this.toMenu('move');
        return;
      case 'over':
        if (button === 'a' || button === 'start') this.startGame();
        else if (button === 'select') this.toMenu('move');
        return;
    }
  }

  release(button: HandheldButton): void {
    const action = toAction(button);
    if (!action || !this.held.delete(button)) return;
    // A 和 B 都映射到 action：两个都松开才算松开
    if ([...this.held].some(other => toAction(other) === action)) return;
    this.game?.key(action, false);
  }

  pause(notice: string | null = null): void {
    if (notice) this.notice = notice;
    if (this.mode !== 'playing') return;
    this.releaseAll();
    this.mode = 'paused';
    this.opts.onSound?.('pause');
  }

  resume(): void {
    if (this.mode !== 'paused') return;
    this.notice = null;
    this.mode = 'playing';
  }

  step(dtMs: number): void {
    if (this.mode === 'boot') {
      const before = this.bootMs;
      this.bootMs += dtMs;
      if (before < 700 && this.bootMs >= 700) this.opts.onSound?.('boot');
      if (this.bootMs >= BOOT_MS) this.toMenu(null);
      return;
    }
    if (this.mode !== 'playing' || !this.game) return;
    this.game.step(dtMs);
    this.trackScore();
    if (this.game.over) {
      this.releaseAll();
      this.mode = 'over';
      this.opts.onSound?.('over');
    }
  }

  private trackScore(): void {
    const score = this.score;
    if (score > this.best()) {
      this.bests.set(this.gameId, score);
      this.opts.best.write(this.gameId, score);
    }
    // 跑酷按距离连续加分，每 100 分响一次；其余每得一分响一次
    const mark = this.gameId === 'runner' ? Math.floor(score / 100) : score;
    if (mark > this.lastScoreMark) this.opts.onSound?.('score');
    this.lastScoreMark = mark;
  }

  private moveMenu(delta: number): void {
    const n = ARCADE_GAME_IDS.length;
    this.menuIndex = (this.menuIndex + delta + n) % n;
    this.opts.onSound?.('move');
  }

  private toMenu(sound: ScreenSound | null): void {
    this.releaseAll();
    this.game = null;
    this.notice = null;
    this.mode = 'menu';
    if (sound) this.opts.onSound?.(sound);
  }

  private startGame(): void {
    this.releaseAll();
    this.game = createArcadeGame(this.gameId);
    this.lastScoreMark = 0;
    this.notice = null;
    this.mode = 'playing';
    this.opts.onSound?.('confirm');
    this.opts.onGameChange?.(this.gameId);
  }

  private releaseAll(): void {
    for (const button of this.held) {
      const action = toAction(button);
      if (action) this.game?.key(action, false);
    }
    this.held.clear();
  }

  // ─── 绘制 ───────────────────────────────────────────────

  draw(ctx: CanvasRenderingContext2D): void {
    const c = LCD_PALETTE;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    if (this.mode === 'boot') return this.drawBoot(ctx);
    if (this.mode === 'menu') return this.drawMenu(ctx);
    this.game?.draw(ctx, c);
    this.drawHud(ctx);
    if (this.mode === 'paused') {
      this.drawPanel(ctx, this.notice ?? this.opts.text.paused, this.opts.text.pausedHint);
    } else if (this.mode === 'over') {
      this.drawPanel(ctx, this.opts.text.gameOver, `${this.score}  ·  ${this.opts.text.overHint}`);
    }
  }

  private drawBoot(ctx: CanvasRenderingContext2D): void {
    const t = this.bootMs;
    ctx.fillStyle = '#f4f5ef';
    ctx.fillRect(0, 0, W, H);
    // 字标从上方滑入，落定后逐字点亮颜色，最后一道高光扫过
    const drop = Math.min(1, t / 700);
    const eased = 1 - (1 - drop) ** 3;
    const y = -20 + eased * (H / 2 - 4 + 20);
    const word = this.opts.text.wordmark;
    ctx.font = 'italic 900 22px "Arial Black", "Helvetica Neue", sans-serif';
    const colors = ['#2b3fa0', '#2b3fa0', '#c63f36', '#e0a21b', '#2f9a4d', '#2b3fa0'];
    const widths = [...word].map(ch => ctx.measureText(ch).width);
    let x = W / 2 - widths.reduce((a, b) => a + b, 0) / 2;
    [...word].forEach((ch, i) => {
      const lit = t > 700 + i * 60;
      ctx.fillStyle = lit ? colors[i % colors.length] : '#9aa0b4';
      ctx.textAlign = 'left';
      ctx.fillText(ch, x, y);
      x += widths[i];
    });
    if (t > 1100) {
      const sweep = Math.min(1, (t - 1100) / 450);
      const sx = -40 + sweep * (W + 80);
      const grad = ctx.createLinearGradient(sx - 30, 0, sx + 30, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.85)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, y - 16, W, 32);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#9aa0b4';
    ctx.font = '600 7px "Helvetica Neue", sans-serif';
    if (t > 1300) ctx.fillText('™', W / 2 + 70, y - 12);
  }

  private drawMenu(ctx: CanvasRenderingContext2D): void {
    const c = LCD_PALETTE;
    const text = this.opts.text;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = c.ink;
    ctx.fillRect(0, 0, W, 22);
    ctx.fillStyle = c.bg;
    ctx.font = '700 11px "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.fillText(text.menuTitle, W / 2, 11);
    ARCADE_GAME_IDS.forEach((id, i) => {
      const y = 46 + i * 28;
      const active = i === this.menuIndex;
      if (active) {
        ctx.fillStyle = c.line;
        ctx.fillRect(24, y - 11, W - 48, 22);
        ctx.fillStyle = c.accent;
        ctx.textAlign = 'left';
        ctx.font = '700 10px ui-monospace, monospace';
        ctx.fillText('▶', 32, y);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = active ? c.ink : c.muted;
      ctx.font = `${active ? 700 : 500} 12px "PingFang SC", "Helvetica Neue", sans-serif`;
      ctx.fillText(text.games[id], 48, y);
      ctx.textAlign = 'right';
      ctx.font = '500 9px ui-monospace, monospace';
      ctx.fillStyle = c.muted;
      ctx.fillText(`${text.best} ${this.best(id)}`, W - 32, y);
    });
    ctx.textAlign = 'center';
    ctx.fillStyle = c.muted;
    ctx.font = '500 9px "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.fillText(text.menuHint, W / 2, H - 12);
  }

  private drawHud(ctx: CanvasRenderingContext2D): void {
    const c = LCD_PALETTE;
    const label = String(this.score).padStart(4, '0');
    ctx.font = '700 9px ui-monospace, monospace';
    const w = ctx.measureText(label).width + 8;
    // 打砖块右上角自己画关卡号，HUD 放到中间避免重叠
    const x = this.gameId === 'breakout' ? W / 2 - w / 2 : W - w - 3;
    ctx.fillStyle = 'rgba(205,211,191,0.85)';
    ctx.fillRect(x, 2, w, 12);
    ctx.fillStyle = c.ink;
    ctx.textAlign = 'center';
    ctx.fillText(label, x + w / 2, 8.5);
  }

  private drawPanel(ctx: CanvasRenderingContext2D, title: string, hint: string): void {
    const c = LCD_PALETTE;
    ctx.fillStyle = 'rgba(28,34,48,0.55)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = c.bg;
    ctx.fillRect(28, H / 2 - 26, W - 56, 52);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(29, H / 2 - 25, W - 58, 50);
    ctx.textAlign = 'center';
    ctx.fillStyle = c.ink;
    ctx.font = '700 13px "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.fillText(title, W / 2, H / 2 - 8);
    ctx.fillStyle = c.muted;
    ctx.font = '500 9px "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.fillText(hint, W / 2, H / 2 + 11);
  }
}
