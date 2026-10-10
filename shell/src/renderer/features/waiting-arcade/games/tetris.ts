// 俄罗斯方块，按现代标准规则实现：
// 7-bag 出块、SRS 旋转与踢墙、HOLD、三块预览、幽灵落点、锁定延迟（移动 / 旋转可续，
// 最多 15 次）、左右长按自动连移（DAS / ARR）、软降 / 硬降、T-Spin（三角判定）、
// 背靠背 ×1.5、连击加分；每 10 行升一级，重力按标准曲线加速。
//
// 键位：←→ 移动，↓ 软降，↑ 硬降，A 顺时针，B 逆时针，L / R 暂存。

import {
  ARCADE_HEIGHT,
  ARCADE_WIDTH,
  EventfulGame,
  type ArcadeAction,
  type ArcadeGame,
  type ArcadePalette,
  type Rng,
} from './types';

export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export const KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export const COLS = 10;
export const VISIBLE_ROWS = 20;
const HIDDEN_ROWS = 2;
export const ROWS = VISIBLE_ROWS + HIDDEN_ROWS;

const DAS_MS = 150;
const ARR_MS = 40;
const SOFT_DROP_MS = 35;
const LOCK_MS = 500;
const MAX_LOCK_RESETS = 15;
const CLEAR_MS = 220;
const POPUP_MS = 1000;

const SHAPES: Record<PieceKind, string[]> = {
  I: ['....', '####', '....', '....'],
  O: ['##', '##'],
  T: ['.#.', '###', '...'],
  S: ['.##', '##.', '...'],
  Z: ['##.', '.##', '...'],
  J: ['#..', '###', '...'],
  L: ['..#', '###', '...'],
};

type Cell = [x: number, y: number];

/** 每种方块 4 个旋转态的格子坐标（矩阵顺时针旋转得出）。 */
const ROTATIONS: Record<PieceKind, Cell[][]> = Object.fromEntries(KINDS.map(kind => {
  let grid = SHAPES[kind].map(row => [...row].map(ch => ch === '#'));
  const states: Cell[][] = [];
  for (let r = 0; r < 4; r++) {
    const cells: Cell[] = [];
    grid.forEach((row, y) => row.forEach((on, x) => { if (on) cells.push([x, y]); }));
    states.push(cells);
    const n = grid.length;
    grid = grid.map((row, y) => row.map((_, x) => grid[n - 1 - x][y]));
  }
  return [kind, states];
})) as Record<PieceKind, Cell[][]>;

// SRS 踢墙表（x 向右、y 向上），使用时把 y 取反换成屏幕坐标
const KICKS_JLSTZ: Record<string, Cell[]> = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const KICKS_I: Record<string, Cell[]> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

export const PIECE_COLORS: Record<PieceKind, string> = {
  I: '#3b8fb3',
  O: '#c9a227',
  T: '#7d4fa0',
  S: '#4f9a4a',
  Z: '#c0443a',
  J: '#2c5aa8',
  L: '#d07a2a',
};

export interface ActivePiece { kind: PieceKind; rot: number; x: number; y: number }

/** 标准重力曲线：每下落一格需要的毫秒数。 */
export function gravityMs(level: number): number {
  const seconds = (0.8 - (level - 1) * 0.007) ** (level - 1);
  return Math.max(16, seconds * 1000);
}

const LINE_SCORES = [0, 100, 300, 500, 800];
const TSPIN_SCORES = [400, 800, 1200, 1600];

export class TetrisGame extends EventfulGame implements ArcadeGame {
  readonly ownHud = true;
  score = 0;
  over = false;
  level = 1;
  lines = 0;
  board: (PieceKind | null)[][] = [];
  active: ActivePiece | null = null;
  queue: PieceKind[] = [];
  hold: PieceKind | null = null;
  holdUsed = false;
  combo = -1;
  backToBack = false;
  /** 正在闪烁、即将消除的行。 */
  clearing: { rows: number[]; ms: number } | null = null;
  popup: { text: string; ms: number } | null = null;
  private bag: PieceKind[] = [];
  private gravityAcc = 0;
  private lockMs = 0;
  private lockResets = 0;
  private lowestY = 0;
  private lastMoveRotate = false;
  private shift: { dir: -1 | 1; ms: number; charged: boolean } | null = null;
  private held = { left: false, right: false, down: false };

  constructor(private readonly rng: Rng = Math.random) {
    super();
    this.reset();
  }

  reset(): void {
    this.board = Array.from({ length: ROWS }, () => Array<PieceKind | null>(COLS).fill(null));
    this.score = 0;
    this.over = false;
    this.level = 1;
    this.lines = 0;
    this.hold = null;
    this.holdUsed = false;
    this.combo = -1;
    this.backToBack = false;
    this.clearing = null;
    this.popup = null;
    this.bag = [];
    this.queue = [];
    this.shift = null;
    this.held = { left: false, right: false, down: false };
    this.fillQueue();
    this.spawn();
  }

  // ─── 出块 ───

  private fillQueue(): void {
    while (this.queue.length < 4) {
      if (this.bag.length === 0) {
        this.bag = [...KINDS];
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1));
          [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
        }
      }
      this.queue.push(this.bag.pop()!);
    }
  }

  private spawn(kind?: PieceKind): void {
    const next = kind ?? this.queue.shift()!;
    this.fillQueue();
    const size = SHAPES[next].length;
    this.active = { kind: next, rot: 0, x: Math.floor((COLS - size) / 2), y: next === 'I' ? 0 : 1 };
    this.gravityAcc = 0;
    this.lockMs = 0;
    this.lockResets = 0;
    this.lowestY = this.active.y;
    this.lastMoveRotate = false;
    if (!this.fits(this.active)) {
      this.over = true;
      this.emit('lose');
    }
  }

  cells(piece: ActivePiece): Cell[] {
    return ROTATIONS[piece.kind][piece.rot].map(([x, y]) => [x + piece.x, y + piece.y]);
  }

  fits(piece: ActivePiece): boolean {
    return this.cells(piece).every(([x, y]) =>
      x >= 0 && x < COLS && y >= 0 && y < ROWS && this.board[y][x] === null);
  }

  // ─── 输入 ───

  key(action: ArcadeAction, down: boolean): void {
    if (action === 'left' || action === 'right') {
      this.held[action] = down;
      const dir = action === 'left' ? -1 : 1;
      if (down) {
        this.shift = { dir, ms: 0, charged: false };
        if (this.canAct()) this.tryMove(dir, 0);
      } else if (this.shift?.dir === dir) {
        // 松开当前方向时，若另一侧还按着就接着往那边连移
        const other = action === 'left' ? 'right' : 'left';
        this.shift = this.held[other] ? { dir: other === 'left' ? -1 : 1, ms: 0, charged: false } : null;
      }
      return;
    }
    if (action === 'down') {
      this.held.down = down;
      return;
    }
    if (!down || !this.canAct()) return;
    if (action === 'up') this.hardDrop();
    else if (action === 'a') this.rotate(1);
    else if (action === 'b') this.rotate(-1);
    else if (action === 'l' || action === 'r') this.swapHold();
  }

  private canAct(): boolean {
    return !this.over && !this.clearing && this.active !== null;
  }

  tryMove(dx: number, dy: number): boolean {
    if (!this.active) return false;
    const moved = { ...this.active, x: this.active.x + dx, y: this.active.y + dy };
    if (!this.fits(moved)) return false;
    this.active = moved;
    this.lastMoveRotate = false;
    if (dy > 0 && moved.y > this.lowestY) {
      this.lowestY = moved.y;
      this.lockResets = 0;
    }
    this.touchLock();
    return true;
  }

  rotate(dir: 1 | -1): boolean {
    const piece = this.active;
    if (!piece || piece.kind === 'O') return false;
    const to = (piece.rot + dir + 4) % 4;
    const table = piece.kind === 'I' ? KICKS_I : KICKS_JLSTZ;
    for (const [kx, ky] of table[`${piece.rot}>${to}`]) {
      const candidate = { ...piece, rot: to, x: piece.x + kx, y: piece.y - ky };
      if (this.fits(candidate)) {
        this.active = candidate;
        this.lastMoveRotate = true;
        this.touchLock();
        this.emit('tick');
        return true;
      }
    }
    return false;
  }

  /** 着地状态下的移动 / 旋转会重置锁定计时，但次数有上限，防止无限拖延。 */
  private touchLock(): void {
    if (this.grounded() && this.lockResets < MAX_LOCK_RESETS) {
      this.lockMs = 0;
      this.lockResets += 1;
    }
  }

  grounded(): boolean {
    return !!this.active && !this.fits({ ...this.active, y: this.active.y + 1 });
  }

  ghostY(): number {
    if (!this.active) return 0;
    let y = this.active.y;
    while (this.fits({ ...this.active, y: y + 1 })) y += 1;
    return y;
  }

  hardDrop(): void {
    if (!this.active) return;
    const target = this.ghostY();
    const rows = target - this.active.y;
    if (rows > 0) this.lastMoveRotate = false;
    this.score += rows * 2;
    this.active = { ...this.active, y: target };
    this.lock();
  }

  private swapHold(): void {
    if (!this.active || this.holdUsed) return;
    const current = this.active.kind;
    const swapIn = this.hold;
    this.hold = current;
    this.holdUsed = true;
    this.emit('tick');
    this.spawn(swapIn ?? undefined);
  }

  // ─── 推进 ───

  step(dtMs: number): void {
    if (this.over) return;
    if (this.popup) {
      this.popup.ms -= dtMs;
      if (this.popup.ms <= 0) this.popup = null;
    }
    if (this.clearing) {
      this.clearing.ms -= dtMs;
      if (this.clearing.ms <= 0) this.finishClear();
      return;
    }
    if (!this.active) return;

    if (this.shift) {
      this.shift.ms += dtMs;
      const threshold = this.shift.charged ? ARR_MS : DAS_MS;
      while (this.shift && this.shift.ms >= threshold) {
        this.shift.ms -= this.shift.charged ? ARR_MS : DAS_MS;
        this.shift.charged = true;
        if (!this.tryMove(this.shift.dir, 0)) {
          this.shift.ms = 0;
          break;
        }
      }
    }

    const interval = this.held.down ? Math.min(SOFT_DROP_MS, gravityMs(this.level)) : gravityMs(this.level);
    if (this.grounded()) {
      this.gravityAcc = 0;
      this.lockMs += dtMs;
      if (this.lockMs >= LOCK_MS) this.lock();
      return;
    }
    this.gravityAcc += dtMs;
    while (this.gravityAcc >= interval && this.active && !this.grounded()) {
      this.gravityAcc -= interval;
      this.tryMove(0, 1);
      if (this.held.down) this.score += 1;
    }
  }

  /** T-Spin 三角判定：T 块最后一步是旋转，且中心四角至少三个被占。 */
  private isTSpin(): boolean {
    const p = this.active;
    if (!p || p.kind !== 'T' || !this.lastMoveRotate) return false;
    const cx = p.x + 1;
    const cy = p.y + 1;
    const corners = [[cx - 1, cy - 1], [cx + 1, cy - 1], [cx - 1, cy + 1], [cx + 1, cy + 1]];
    const filled = corners.filter(([x, y]) => x < 0 || x >= COLS || y >= ROWS || (y >= 0 && this.board[y][x] !== null));
    return filled.length >= 3;
  }

  private lock(): void {
    const piece = this.active;
    if (!piece) return;
    const tspin = this.isTSpin();
    const cells = this.cells(piece);
    for (const [x, y] of cells) this.board[y][x] = piece.kind;
    this.active = null;
    this.emit('hit');
    // 整块锁在可见区上方 → 顶出
    if (cells.every(([, y]) => y < HIDDEN_ROWS)) {
      this.over = true;
      this.emit('lose');
      return;
    }
    const full = this.board.flatMap((row, y) => (row.every(Boolean) ? [y] : []));
    this.award(full.length, tspin);
    this.holdUsed = false;
    if (full.length > 0) {
      this.clearing = { rows: full, ms: CLEAR_MS };
    } else {
      this.spawn();
    }
  }

  private award(lines: number, tspin: boolean): void {
    if (lines === 0 && !tspin) {
      this.combo = -1;
      return;
    }
    const difficult = lines === 4 || (tspin && lines > 0);
    let points = (tspin ? TSPIN_SCORES[lines] : LINE_SCORES[lines]) * this.level;
    if (difficult && this.backToBack) points = Math.floor(points * 1.5);
    if (lines > 0) {
      this.combo += 1;
      points += 50 * this.combo * this.level;
      this.backToBack = difficult;
    }
    this.score += points;

    const label = tspin
      ? `T-SPIN${lines ? ` ${['', 'SINGLE', 'DOUBLE', 'TRIPLE'][lines]}` : ''}`
      : lines === 4 ? 'TETRIS!' : '';
    const extra = this.combo > 0 ? `COMBO ×${this.combo}` : '';
    const text = [label, extra].filter(Boolean).join('  ');
    if (text) this.popup = { text, ms: POPUP_MS };
    this.emit(difficult ? 'big' : lines > 0 ? 'clear' : 'bonus');
  }

  private finishClear(): void {
    const rows = this.clearing?.rows ?? [];
    this.clearing = null;
    this.board = this.board.filter((_, y) => !rows.includes(y));
    while (this.board.length < ROWS) this.board.unshift(Array<PieceKind | null>(COLS).fill(null));
    this.lines += rows.length;
    const level = 1 + Math.floor(this.lines / 10);
    if (level > this.level) {
      this.level = level;
      this.emit('levelup');
    }
    this.spawn();
  }

  // ─── 绘制 ───

  draw(ctx: CanvasRenderingContext2D, c: ArcadePalette): void {
    const cell = 7;
    const bx = Math.floor((ARCADE_WIDTH - COLS * cell) / 2); // 85
    const by = Math.floor((ARCADE_HEIGHT - VISIBLE_ROWS * cell) / 2); // 10
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, ARCADE_WIDTH, ARCADE_HEIGHT);

    // 棋盘底与网格
    ctx.fillStyle = 'rgba(28,34,48,0.08)';
    ctx.fillRect(bx, by, COLS * cell, VISIBLE_ROWS * cell);
    ctx.fillStyle = 'rgba(28,34,48,0.08)';
    for (let x = 1; x < COLS; x++) ctx.fillRect(bx + x * cell, by, 1, VISIBLE_ROWS * cell);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 1.5, by - 1.5, COLS * cell + 3, VISIBLE_ROWS * cell + 3);

    const flashOn = this.clearing ? Math.floor(this.clearing.ms / 55) % 2 === 0 : false;
    for (let y = HIDDEN_ROWS; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const kind = this.board[y][x];
        if (!kind) continue;
        const px = bx + x * cell;
        const py = by + (y - HIDDEN_ROWS) * cell;
        if (this.clearing?.rows.includes(y)) {
          ctx.fillStyle = flashOn ? '#ffffff' : c.ink;
          ctx.fillRect(px, py, cell, cell);
        } else {
          drawBlock(ctx, px, py, cell, PIECE_COLORS[kind]);
        }
      }
    }

    if (this.active) {
      const ghost = { ...this.active, y: this.ghostY() };
      ctx.strokeStyle = PIECE_COLORS[this.active.kind];
      ctx.globalAlpha = 0.6;
      for (const [x, y] of this.cells(ghost)) {
        if (y < HIDDEN_ROWS) continue;
        ctx.strokeRect(bx + x * cell + 0.5, by + (y - HIDDEN_ROWS) * cell + 0.5, cell - 1, cell - 1);
      }
      ctx.globalAlpha = 1;
      for (const [x, y] of this.cells(this.active)) {
        if (y < HIDDEN_ROWS) continue;
        drawBlock(ctx, bx + x * cell, by + (y - HIDDEN_ROWS) * cell, cell, PIECE_COLORS[this.active.kind]);
      }
    }

    // 左栏：HOLD + 分数
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const left = bx / 2;
    this.label(ctx, c, 'HOLD', left, 14);
    this.miniBox(ctx, c, left, 30, this.hold, this.holdUsed);
    this.stat(ctx, c, 'SCORE', String(this.score), left, 62);
    this.stat(ctx, c, 'LEVEL', String(this.level), left, 92);
    this.stat(ctx, c, 'LINES', String(this.lines), left, 122);

    // 右栏：NEXT ×3
    const right = bx + COLS * cell + (ARCADE_WIDTH - bx - COLS * cell) / 2;
    this.label(ctx, c, 'NEXT', right, 14);
    this.queue.slice(0, 3).forEach((kind, i) => {
      this.miniBox(ctx, c, right, 30 + i * 34, kind, false);
    });

    if (this.popup) {
      ctx.globalAlpha = Math.min(1, this.popup.ms / 250);
      ctx.font = '900 9px ui-monospace, monospace';
      const w = ctx.measureText(this.popup.text).width + 10;
      ctx.fillStyle = c.ink;
      ctx.fillRect(ARCADE_WIDTH / 2 - w / 2, by + 52, w, 14);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText(this.popup.text, ARCADE_WIDTH / 2, by + 59.5);
      ctx.globalAlpha = 1;
    }
  }

  private label(ctx: CanvasRenderingContext2D, c: ArcadePalette, text: string, x: number, y: number): void {
    ctx.fillStyle = c.muted;
    ctx.font = '700 7px ui-monospace, monospace';
    ctx.fillText(text, x, y);
  }

  private stat(ctx: CanvasRenderingContext2D, c: ArcadePalette, name: string, value: string, x: number, y: number): void {
    this.label(ctx, c, name, x, y);
    ctx.fillStyle = c.ink;
    ctx.font = '700 10px ui-monospace, monospace';
    ctx.fillText(value, x, y + 11);
  }

  private miniBox(
    ctx: CanvasRenderingContext2D,
    c: ArcadePalette,
    cx: number,
    cy: number,
    kind: PieceKind | null,
    dim: boolean,
  ): void {
    ctx.strokeStyle = c.line;
    ctx.strokeRect(cx - 22.5, cy - 12.5, 45, 25);
    if (!kind) return;
    const cells = ROTATIONS[kind][0];
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    const size = 5;
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * size;
    const h = (Math.max(...ys) - Math.min(...ys) + 1) * size;
    const ox = cx - w / 2 - Math.min(...xs) * size;
    const oy = cy - h / 2 - Math.min(...ys) * size;
    for (const [x, y] of cells) {
      drawBlock(ctx, ox + x * size, oy + y * size, size, dim ? '#8a9080' : PIECE_COLORS[kind]);
    }
  }
}

/** 带高光与阴影的方块，有实体感。 */
function drawBlock(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillRect(x, y, size, 1);
  ctx.fillRect(x, y, 1, size);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(x, y + size - 1, size, 1);
  ctx.fillRect(x + size - 1, y, 1, size);
}
