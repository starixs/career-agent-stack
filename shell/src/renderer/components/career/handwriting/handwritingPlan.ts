/**
 * 手写句子的纯逻辑：选哪一句、每个墨点什么时候出墨、整句按什么节奏写。渲染见 HandwrittenLine.tsx。
 *
 * 字形是书法手迹字体（志莽行书，glyphs.json）；运笔从字形反推：把楷体笔顺中轴（strokes.json）拉伸对齐到
 * 字形墨迹外框，每个墨点归到离它最近的那一笔，按它在这一笔里的位置排出墨时刻。每笔起收慢、中间快，
 * 离中轴越远的墨点出得越晚（墨往两边晕开）。整句先按原速慢写 2 秒，再平滑加速，6 秒写完；
 * 字间停 70 毫秒、标点停 600 毫秒（按原速计，随变速一起压缩）。参数均为 2026-10-28 用户逐组比较后定版。
 */
import quotes from './quotes.json';

export type QuoteScene = 'daily' | 'done' | 'quiet' | 'setback' | 'start';
export interface Quote { text: string; by?: string; tone: 'encourage' | 'humanist'; scenes: QuoteScene[] }

/** strokes.json 的单字结构：m 为 [笔画中轴路径, 路径长度]，坐标是 1024 方格、y 轴朝上。 */
export interface CharStrokes { m: Array<[string, number]> }
export type StrokeData = Record<string, CharStrokes>;
/** glyphs.json：字形轮廓（字体单位、y 轴朝上、基线为 0）。 */
export interface GlyphOutline { d: string; adv: number }
export interface GlyphData { upm: number; ascent: number; glyphs: Record<string, GlyphOutline> }

export type Point = [number, number];
/** 栅格里的一个墨点：坐标（像素，y 朝下）和不透明度。 */
export interface InkPixel { x: number; y: number; a: number }
/** 一个墨点的出墨：i 为 ImageData 下标，t 为原速下相对本字起笔的毫秒数。 */
export interface InkEvent { i: number; a: number; t: number }
export interface GlyphSchedule { events: InkEvent[]; durationMs: number }

// 每笔时长 = 基础 + 中轴长度（按 176 像素字格计）× 每像素毫秒；笔与笔之间提笔 30 毫秒。
const STROKE_BASE_MS = 60;
const STROKE_MS_PER_PX = 1;
const STROKE_LIFT_MS = 30;
const REFERENCE_CELL = 176;
// 起收强度：0 为笔内匀速，越大起笔收笔越慢（用户定 0.55）。
const STROKE_EASE = 0.55;
// 晕开：墨点离中轴每远 1 像素（176 字格）晚出现的毫秒数（用户定 1）。
const SPREAD_MS_PER_PX = 1;
// 字间、标点处的停顿（原速毫秒，用户定「标点长停」）。
const CHAR_GAP_MS = 70;
const PAUSE_GAP_MS = 600;
// 整句节奏：先按原速写 2 秒，再用 0.6 秒平滑加速，6 秒写完（用户定）。
export const LINE_TOTAL_MS = 6000;
export const LINE_SLOW_MS = 2000;
const LINE_RAMP_MS = 600;
// 中轴每隔多少单位（1024 方格）采一个点；越密归笔越准、越慢。
const MEDIAN_SAMPLE_STEP = 16;
const BEZIER_SAMPLES = 12;

const PAUSE_CHARS = new Set(['，', '。', '？', '！', '；', '、']);

/** 逗号、句号、顿号没有楷体笔顺，给一条与字形走向相近的中轴（1024 方格，落在字格左下）。 */
export const PUNCTUATION_STROKES: StrokeData = {
  '，': { m: [['M210 110C250 80 240 10 160 -60', 200]] },
  '。': { m: [['M210 95C180 95 155 70 155 40C155 10 180 -15 210 -15C240 -15 265 10 265 40C265 70 240 95 214 95', 346]] },
  '、': { m: [['M170 110C200 80 230 40 250 -10', 140]] },
};

const SCENES: readonly QuoteScene[] = ['daily', 'done', 'quiet', 'setback', 'start'];
const isScene = (v: unknown): v is QuoteScene => SCENES.some(s => s === v);

/** quotes.json 是手写的数据文件，加载时校验一遍，写错场景名直接报出是哪一句。 */
export function parseQuotes(raw: readonly unknown[]): Quote[] {
  return raw.map((item, i) => {
    const q = typeof item === 'object' && item !== null ? item : {};
    const text = 'text' in q ? q.text : undefined;
    const by = 'by' in q ? q.by : undefined;
    const tone = 'tone' in q ? q.tone : undefined;
    const scenes = 'scenes' in q && Array.isArray(q.scenes) ? q.scenes : [];
    if (typeof text !== 'string' || (by !== undefined && typeof by !== 'string') || (tone !== 'encourage' && tone !== 'humanist') || scenes.length === 0 || !scenes.every(isScene)) {
      throw new Error(`[handwriting] invalid quote #${i} in quotes.json: ${JSON.stringify(item)}`);
    }
    return { text, by, tone, scenes: scenes.filter(isScene) };
  });
}

export const ALL_QUOTES: readonly Quote[] = parseQuotes(quotes);

/** 同一天同一场景总是同一句，换一天换一句；seed 用来让同一天不同位置错开。 */
export function pickQuote(scene: QuoteScene, dateKey: string, seed = ''): Quote {
  const pool = ALL_QUOTES.filter(q => q.scenes.includes(scene));
  if (pool.length === 0) throw new Error(`[handwriting] no quote for scene "${scene}"`);
  let hash = 0;
  for (const ch of `${scene}|${dateKey}|${seed}`) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return pool[hash % pool.length];
}

export const isPause = (ch: string) => PAUSE_CHARS.has(ch);

/** 按标点把句子切成不可断开的小段：换行只发生在逗号、句号之后，不会把「云帆」拆到两行。 */
export function splitClauses<T extends { ch: string }>(glyphs: T[]): T[][] {
  const clauses: T[][] = [[]];
  for (const g of glyphs) {
    clauses[clauses.length - 1].push(g);
    if (isPause(g.ch)) clauses.push([]);
  }
  return clauses.filter(c => c.length > 0);
}

function cubicAt(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
  const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
  return [x, y];
}

/** 把中轴路径（只含 M / L / C，绝对坐标，即 build 脚本的输出格式）采成一串点，点间距约 MEDIAN_SAMPLE_STEP。 */
export function sampleMedian(path: string): Point[] {
  const dense: Point[] = [];
  for (const [, cmd, args] of path.matchAll(/([MLC])([^MLC]*)/g)) {
    const n = (args.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (cmd === 'C' && dense.length > 0) {
      for (let k = 0; k + 5 < n.length; k += 6) {
        const p0 = dense[dense.length - 1];
        for (let s = 1; s <= BEZIER_SAMPLES; s++) dense.push(cubicAt(p0, [n[k], n[k + 1]], [n[k + 2], n[k + 3]], [n[k + 4], n[k + 5]], s / BEZIER_SAMPLES));
      }
    } else {
      for (let k = 0; k + 1 < n.length; k += 2) dense.push([n[k], n[k + 1]]);
    }
  }
  if (dense.length === 0) throw new Error(`[handwriting] empty median path: ${path.slice(0, 40)}`);
  const out: Point[] = [dense[0]];
  for (const p of dense.slice(1)) {
    const last = out[out.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= MEDIAN_SAMPLE_STEP) out.push(p);
  }
  const end = dense[dense.length - 1];
  if (out.length === 1 || out[out.length - 1] !== end) out.push(end);
  return out;
}

/** 一笔之内的进度：u 是墨点在这一笔里的位置（0 起笔，1 收笔），返回它出墨的时刻（0–1）。 */
export function strokeEase(u: number, amp = STROKE_EASE): number {
  return u + amp * Math.sin(2 * Math.PI * u) / (2 * Math.PI);
}

function bounds(points: readonly Point[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

/** 把楷体中轴（1024 方格、y 朝上）拉伸对齐到字形墨迹外框（像素、y 朝下）。 */
export function fitMedians(medians: readonly Point[][], ink: readonly InkPixel[]): Point[][] {
  const g = bounds(ink.map(p => [p.x, p.y]));
  const m = bounds(medians.flat());
  const sx = (g.x1 - g.x0) / ((m.x1 - m.x0) || 1);
  const sy = (g.y1 - g.y0) / ((m.y1 - m.y0) || 1);
  return medians.map(pts => pts.map(([x, y]) => [g.x0 + (x - m.x0) * sx, g.y0 + (m.y1 - y) * sy]));
}

function polylineLength(pts: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return total;
}

/** 一个字的出墨时间表：墨点归到最近的笔画，按笔顺、笔内位置和离中轴的距离排出墨时刻。 */
export function scheduleGlyph(ink: readonly InkPixel[], medians: readonly Point[][], cell: number): GlyphSchedule {
  if (ink.length === 0) return { events: [], durationMs: 0 };
  const strokes = fitMedians(medians, ink);
  const scale = cell / REFERENCE_CELL;
  const starts: number[] = []; const durs: number[] = [];
  let t = 0;
  for (const pts of strokes) {
    const d = STROKE_BASE_MS + polylineLength(pts) / scale * STROKE_MS_PER_PX;
    starts.push(t); durs.push(d); t += d + STROKE_LIFT_MS;
  }
  const events = ink.map(({ x, y, a }) => {
    let best = Infinity; let bs = 0; let bu = 0;
    strokes.forEach((pts, si) => pts.forEach((p, i) => {
      const d2 = (p[0] - x) ** 2 + (p[1] - y) ** 2;
      if (d2 < best) { best = d2; bs = si; bu = pts.length > 1 ? i / (pts.length - 1) : 0; }
    }));
    const spread = Math.sqrt(best) / scale * SPREAD_MS_PER_PX;
    return { i: (y * cell + x) * 4, a, t: starts[bs] + durs[bs] * strokeEase(bu) + spread };
  }).sort((p, q) => p.t - q.t);
  return { events, durationMs: t - STROKE_LIFT_MS };
}

/** 整句里每个字的起笔时刻（原速毫秒）和最后一笔落下的时刻：字间停 70、标点停 600。 */
export function lineOffsets(chars: readonly string[], durations: readonly number[]): { offsets: number[]; inkEndMs: number } {
  const offsets: number[] = [];
  let t = 0; let inkEndMs = 0;
  chars.forEach((ch, i) => {
    offsets.push(t);
    inkEndMs = t + durations[i];
    t = inkEndMs + (isPause(ch) ? PAUSE_GAP_MS : CHAR_GAP_MS);
  });
  return { offsets, inkEndMs };
}

/**
 * 变速时间线：真实经过的毫秒 → 原速时间线上的毫秒。前 slow 毫秒按原速（1 倍）写，之后用 smoothstep
 * 在 LINE_RAMP_MS 内平滑加速到 fast 倍，最后一笔正好落在 total。fast = (内容总长 - 慢段) / (total - slow)；
 * 平滑段对称，所以总量不变。内容太短、慢段就能写完时退回匀速铺满 total。
 */
export function makeWarp(naturalMs: number, totalMs = LINE_TOTAL_MS, slowMs = LINE_SLOW_MS): (elapsedMs: number) => number {
  const fast = (naturalMs - slowMs) / (totalMs - slowMs);
  if (fast <= 1) return r => r * naturalMs / totalMs;
  const w = Math.min(LINE_RAMP_MS, slowMs, totalMs - slowMs);
  const r0 = slowMs - w / 2; const r1 = slowMs + w / 2;
  return r => {
    if (r <= r0) return r;
    if (r >= r1) return r0 + w * (1 + fast) / 2 + fast * (r - r1);
    const x = (r - r0) / w;
    return r0 + w * (x + (fast - 1) * (x ** 3 - x ** 4 / 2));
  };
}
