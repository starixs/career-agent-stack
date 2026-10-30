// 掌机屏幕状态机：开机 → 选游戏菜单 → 游戏中 ⇄ 暂停 → 结束。
// 纯逻辑 + canvas 绘制，不碰 React / DOM 事件，可在 node 单测里直接驱动。

import {
  ARCADE_GAME_IDS,
  DEFAULT_GAME,
  ARCADE_HEIGHT as H,
  ARCADE_WIDTH as W,
  createArcadeGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadeGameId,
  type GameEvent,
} from '../games';
import { FxLayer } from './fx';
import { LCD_PALETTE, themeForStage, type StageTheme, type ThemeId } from './themes';

export type HandheldButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'start' | 'select' | 'l' | 'r';
export type ScreenMode = 'boot' | 'menu' | 'playing' | 'paused' | 'over' | 'confirm';
export type ScreenSound =
  | 'boot' | 'move' | 'confirm' | 'pause' | 'over'
  | 'score' | 'bonus' | 'levelup' | 'hit' | 'clear' | 'big' | 'tick' | 'lose';

export { LCD_PALETTE } from './themes';

export const BOOT_MS = 1900;
const MENU_ROWS = 5;
/** 输了以后先让画面播完爆炸、震屏，再盖结束面板；这段时间按 A 不会误触重开。 */
export const OVER_DELAY_MS = 650;
/** 换景时新场景从左往右扫过去的时长；期间游戏照常进行。 */
export const WIPE_MS = 650;

export interface ScreenText {
  wordmark: string;
  menuTitle: string;
  menuHint: string;
  best: string;
  paused: string;
  pausedHint: string;
  gameOver: string;
  newRecord: string;
  overHint: string;
  /** 收起前的确认面板。 */
  confirmClose: string;
  confirmHint: string;
  games: Record<ArcadeGameId, string>;
  /** 场景名，换景时在屏幕顶部亮一下。 */
  themes: Record<ThemeId, string>;
}

export interface BestScoreStore {
  read(id: ArcadeGameId): number;
  write(id: ArcadeGameId, score: number): void;
}

interface ScreenOptions {
  text: ScreenText;
  best: BestScoreStore;
  initialGame?: ArcadeGameId;
  /** semitones：连击时得分音逐级升高。 */
  onSound?: (sound: ScreenSound, semitones?: number) => void;
  onGameChange?: (id: ArcadeGameId) => void;
}

/** START / SELECT 归屏幕，其余实体键原样交给游戏。 */
function toAction(button: HandheldButton): ArcadeAction | null {
  return button === 'start' || button === 'select' ? null : button;
}

const EVENT_SOUNDS: Record<GameEvent, ScreenSound> = {
  score: 'score',
  bonus: 'bonus',
  levelup: 'levelup',
  hit: 'hit',
  clear: 'clear',
  big: 'big',
  tick: 'tick',
  lose: 'lose',
};

export class HandheldScreen {
  mode: ScreenMode = 'boot';
  bootMs = 0;
  menuIndex: number;
  game: ArcadeGame | null = null;
  /** 暂停时屏幕上显示的外部原因（如「AI 回复好了」），优先于普通暂停文案。 */
  notice: string | null = null;
  private held = new Set<HandheldButton>();
  /** 本局开始时的最高分，用来判断结束时是不是破了纪录。 */
  private bestAtStart = 0;
  private readonly bests = new Map<ArcadeGameId, number>();
  readonly fx = new FxLayer(LCD_PALETTE);
  /** 进入结束状态后过了多久。 */
  overMs = 0;
  /** 本局是否已经提示过破纪录。 */
  private recordShown = false;
  /** 当前场景，以及换景过场里旧场景还剩多少没被扫掉。 */
  theme: StageTheme = themeForStage(1);
  private stage = 1;
  private wipe: { from: StageTheme; ms: number } | null = null;
  /** 确认收起时底下是哪个画面；取消后回到这里（游戏中会先变成暂停）。 */
  private beforeConfirm: Exclude<ScreenMode, 'confirm' | 'playing' | 'boot'> = 'menu';

  constructor(private readonly opts: ScreenOptions) {
    this.menuIndex = Math.max(0, ARCADE_GAME_IDS.indexOf(opts.initialGame ?? DEFAULT_GAME));
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
    if (this.mode === 'over') return this.overMs < OVER_DELAY_MS || this.fx.active;
    return this.mode === 'boot' || this.mode === 'playing';
  }

  /** 结束面板是否已经出现（可以按 A 重开）。 */
  get overReady(): boolean {
    return this.mode === 'over' && this.overMs >= OVER_DELAY_MS;
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
          this.flushEvents();
        }
        return;
      }
      case 'paused':
        if (button === 'start' || button === 'a') this.resume();
        else if (button === 'select') this.toMenu('move');
        return;
      case 'over':
        if (!this.overReady) return;
        if (button === 'a' || button === 'start') this.startGame();
        else if (button === 'select') this.toMenu('move');
        return;
      case 'confirm':
        if (button === 'a' || button === 'b' || button === 'start' || button === 'select') this.cancelClose();
        return;
    }
  }

  /**
   * Esc 一层层往回退：游戏中 → 暂停 → 菜单 → 确认收起；只有在确认面板上再按才返回 false，
   * 由宿主把掌机收起来。收起后本轮就不能再玩，所以一定要确认这一下。
   */
  back(): boolean {
    switch (this.mode) {
      case 'playing':
        this.pause();
        return true;
      case 'paused':
      case 'over':
        this.toMenu('move');
        return true;
      case 'boot':
      case 'menu':
        this.askClose();
        return true;
      case 'confirm':
        return false;
    }
  }

  /** 弹出「收起掌机？」；电源开关也走这里。游戏中先暂停，取消后停在暂停画面。 */
  askClose(): void {
    if (this.mode === 'confirm') return;
    if (this.mode === 'playing') this.pause();
    if (this.mode === 'boot') this.toMenu(null);
    this.beforeConfirm = this.mode as typeof this.beforeConfirm;
    this.mode = 'confirm';
    this.opts.onSound?.('pause');
  }

  cancelClose(): void {
    if (this.mode !== 'confirm') return;
    this.mode = this.beforeConfirm;
    this.opts.onSound?.('move');
  }

  release(button: HandheldButton): void {
    const action = toAction(button);
    if (!action || !this.held.delete(button)) return;
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
    if (this.mode === 'over') {
      this.overMs += dtMs;
      this.fx.step(dtMs);
      return;
    }
    if (this.mode !== 'playing' || !this.game) return;
    this.fx.step(dtMs);
    if (this.wipe) {
      this.wipe.ms += dtMs;
      if (this.wipe.ms >= WIPE_MS) this.wipe = null;
    }
    // 命中定格：逻辑停住，粒子照常飞
    if (this.fx.hitstopMs > 0) return;
    this.game.step(dtMs);
    this.trackStage();
    this.trackBest();
    if (this.game.over) {
      this.game.drainEvents(); // 结束时只放结束音效
      this.fx.push(this.game.drainFx());
      this.fx.push([{ kind: 'shake', power: 0.8 }, { kind: 'flash', color: 'accent', alpha: 0.35 }]);
      this.releaseAll();
      this.mode = 'over';
      this.overMs = 0;
      this.opts.onSound?.('over');
      return;
    }
    this.flushEvents();
  }

  /** 一帧里同类事件只响一次，避免多球同时撞砖时叠成噪音。 */
  private flushEvents(): void {
    const events = new Set(this.game?.drainEvents() ?? []);
    const effects = this.game?.drainFx() ?? [];
    this.fx.push(effects);
    // 连击用升调的得分音代替普通得分音
    const combo = effects.reduce((n, f) => (f.kind === 'combo' ? Math.max(n, f.n) : n), 0);
    if (combo > 0) {
      events.delete('score');
      this.opts.onSound?.('score', Math.min(14, (combo - 1) * 2));
    }
    // 每个游戏都自带的底线反馈：升级闪一下，丢命震一下
    if (events.has('levelup')) this.fx.push([{ kind: 'flash', color: '#ffffff', alpha: 0.45 }]);
    if (events.has('lose')) this.fx.push([{ kind: 'shake', power: 0.7 }, { kind: 'flash', color: 'accent', alpha: 0.3 }]);
    for (const event of events) this.opts.onSound?.(EVENT_SOUNDS[event]);
  }

  /** 游戏进了新的一关：换一套场景，新场景从左往右扫进来，顶部亮出场景名。 */
  private trackStage(): void {
    const game = this.game;
    if (!game) return;
    const stage = game.stage ?? game.level;
    if (stage === this.stage) return;
    this.stage = stage;
    const next = themeForStage(stage, game.palette);
    if (next.id === this.theme.id && next.palette.bg === this.theme.palette.bg) return;
    this.wipe = { from: this.theme, ms: 0 };
    this.applyTheme(next);
    this.fx.showTag(this.opts.text.themes[next.id]);
  }

  private applyTheme(theme: StageTheme): void {
    this.theme = theme;
    this.fx.palette = theme.palette;
    this.fx.setAmbient(theme.ambient);
  }

  private trackBest(): void {
    const score = this.score;
    // 局中超过上次最高分的那一刻就告诉玩家，不等到结束
    if (!this.recordShown && this.bestAtStart > 0 && score > this.bestAtStart) {
      this.recordShown = true;
      this.fx.push([{ kind: 'popup', x: W / 2, y: 30, text: this.opts.text.newRecord, color: 'accent' }]);
      this.opts.onSound?.('bonus');
    }
    if (score > this.best()) {
      this.bests.set(this.gameId, score);
      this.opts.best.write(this.gameId, score);
    }
  }

  /** 本局是否刷新了最高分。 */
  get newRecord(): boolean {
    return this.score > 0 && this.score > this.bestAtStart;
  }

  private moveMenu(delta: number): void {
    const n = ARCADE_GAME_IDS.length;
    this.menuIndex = (this.menuIndex + delta + n) % n;
    this.opts.onSound?.('move');
  }

  private toMenu(sound: ScreenSound | null): void {
    this.releaseAll();
    this.fx.clear();
    this.game = null;
    this.notice = null;
    this.mode = 'menu';
    if (sound) this.opts.onSound?.(sound);
  }

  private startGame(): void {
    this.releaseAll();
    this.game = createArcadeGame(this.gameId);
    this.fx.clear();
    this.stage = this.game.stage ?? this.game.level;
    this.wipe = null;
    this.applyTheme(themeForStage(this.stage, this.game.palette));
    this.recordShown = false;
    this.overMs = 0;
    this.bestAtStart = this.best();
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
    const c = this.theme.palette;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    if (this.mode === 'boot') return this.drawBoot(ctx);
    // 确认面板盖在原来的画面上
    const shown = this.mode === 'confirm' ? this.beforeConfirm : this.mode;
    if (shown === 'menu') {
      this.drawMenu(ctx);
      if (this.mode === 'confirm') this.drawPanel(ctx, this.opts.text.confirmClose, this.opts.text.confirmHint);
      return;
    }
    // 震屏时边缘会露出上一帧，先整屏铺底
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    const [ox, oy] = this.fx.offset();
    ctx.save();
    ctx.translate(ox, oy);
    this.drawGame(ctx);
    this.fx.drawWorld(ctx);
    ctx.restore();
    this.drawHud(ctx);
    this.fx.drawOverlay(ctx);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    if (this.mode === 'confirm') {
      this.drawPanel(ctx, this.opts.text.confirmClose, this.opts.text.confirmHint);
    } else if (this.mode === 'paused') {
      this.drawPanel(ctx, this.notice ?? this.opts.text.paused, this.opts.text.pausedHint);
    } else if (this.overReady) {
      const title = this.newRecord ? this.opts.text.newRecord : this.opts.text.gameOver;
      this.drawPanel(ctx, title, `${this.score}  ·  ${this.opts.text.overHint}`);
    }
  }

  /** 换景过场：先按旧场景画一遍，再把扫过的区域按新场景重画，接缝处一道亮边。 */
  private drawGame(ctx: CanvasRenderingContext2D): void {
    const game = this.game;
    if (!game) return;
    const c = this.theme.palette;
    if (!this.wipe) {
      game.draw(ctx, c);
      return;
    }
    const t = this.wipe.ms / WIPE_MS;
    const eased = 1 - (1 - t) ** 3;
    const slant = 40;
    const edge = -slant + eased * (W + slant * 2);
    game.draw(ctx, this.wipe.from.palette);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-10, -10);
    ctx.lineTo(edge + slant / 2, -10);
    ctx.lineTo(edge - slant / 2, H + 10);
    ctx.lineTo(-10, H + 10);
    ctx.closePath();
    ctx.clip();
    game.draw(ctx, c);
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(edge + slant / 2, -10);
    ctx.lineTo(edge - slant / 2, H + 10);
    ctx.stroke();
    ctx.restore();
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
    // 一屏放 5 行，光标尽量停在中间那行，列表跟着滚
    const n = ARCADE_GAME_IDS.length;
    const first = Math.max(0, Math.min(n - MENU_ROWS, this.menuIndex - Math.floor(MENU_ROWS / 2)));
    ARCADE_GAME_IDS.slice(first, first + MENU_ROWS).forEach((id, row) => {
      const i = first + row;
      const y = 37 + row * 22;
      const active = i === this.menuIndex;
      if (active) {
        ctx.fillStyle = c.line;
        ctx.fillRect(24, y - 10, W - 48, 20);
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
    ctx.font = '700 7px ui-monospace, monospace';
    if (first > 0) ctx.fillText('▲', W / 2, 28);
    if (first + MENU_ROWS < n) ctx.fillText('▼', W / 2, 137);
    ctx.font = '500 9px "PingFang SC", "Helvetica Neue", sans-serif';
    ctx.fillText(text.menuHint, W / 2, H - 12);
  }

  /** 顶部一条半透明 HUD：左边等级 + 命数，右边分数。自带面板的游戏不画。 */
  private drawHud(ctx: CanvasRenderingContext2D): void {
    const game = this.game;
    if (!game || game.ownHud) return;
    const c = this.theme.palette;
    ctx.font = '700 9px ui-monospace, monospace';
    const level = `LV${game.level}`;
    const lives = game.lives !== undefined ? ' ' + '♥'.repeat(Math.max(0, game.lives)) : '';
    const leftText = level + lives;
    const score = String(this.score).padStart(5, '0');
    const lw = ctx.measureText(leftText).width + 8;
    const rw = ctx.measureText(score).width + 8;
    ctx.fillStyle = c.bg;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(2, 2, lw, 12);
    ctx.fillRect(W - rw - 2, 2, rw, 12);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = c.ink;
    ctx.fillText(level, 6, 8.5);
    if (lives) {
      ctx.fillStyle = c.accent;
      ctx.fillText(lives, 6 + ctx.measureText(level).width, 8.5);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = c.ink;
    ctx.fillText(score, W - 6, 8.5);
    ctx.textAlign = 'center';
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
