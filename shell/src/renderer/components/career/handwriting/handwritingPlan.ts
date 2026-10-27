/**
 * 手写句子的纯逻辑：选哪一句、每一笔什么时候落笔、写多久、每个字歪多少。渲染见 HandwrittenLine.tsx。
 *
 * 笔迹是一支钢笔沿笔画中轴走过去（不按楷体轮廓裁剪），所以看起来是手写而不是字体。
 * 节奏按「人写字」排：一个字的时长随笔画数增长，字内按笔画长短分配，每一笔快慢略有起伏，
 * 笔与笔之间留一点提笔的空，逗号句号处停顿更久，像换气。每个字带一点歪斜、高低和大小差，
 * 由句子本身算出的种子决定——同一句话每次写出来都一样。
 */
import quotes from './quotes.json';

export type QuoteScene = 'daily' | 'done' | 'quiet' | 'setback' | 'start';
export interface Quote { text: string; by?: string; tone: 'encourage' | 'humanist'; scenes: QuoteScene[] }

/** strokes.json 的单字结构：m 为 [平滑后的笔迹路径, 路径长度]，坐标是 1024 方格、y 轴朝上。 */
export interface CharStrokes { m: Array<[string, number]> }
export type StrokeData = Record<string, CharStrokes>;

export interface PlannedStroke { path: string; length: number; delayMs: number; durationMs: number }
/** 每个字的手写偏差：旋转角度（度）、上下偏移（em）、缩放。 */
export interface GlyphWobble { rotate: number; dy: number; scale: number }
export type PlannedGlyph =
  | { kind: 'pen'; ch: string; narrow: boolean; wobble: GlyphWobble; strokes: PlannedStroke[] }
  | { kind: 'text'; ch: string; delayMs: number };
export interface WritingPlan { glyphs: PlannedGlyph[]; totalMs: number }

// 一个字的基础时长 + 每多一笔加的时长：一笔字约 0.17 秒，十笔字约 0.4 秒（钢笔比毛笔快）。
const CHAR_BASE_MS = 150;
const PER_STROKE_MS = 25;
// 字内提笔留白占这个字时长的比例。
const LIFT_RATIO = 0.14;
// 每一笔的时长在 ±15% 之间起伏，避免机器般匀速。
const RHYTHM_SPREAD = 0.3;
// 字与字之间、标点处（换气）的停顿。
const CHAR_GAP_MS = 50;
const PAUSE_MS = 240;
const PAUSE_CHARS = new Set(['，', '。', '？', '！', '；', '、']);
// 手写偏差的幅度：±4 度、±0.05em、0.93–1.05 倍。
const WOBBLE_ROTATE_DEG = 4;
const WOBBLE_DY_EM = 0.05;
const WOBBLE_SCALE_MIN = 0.93;
const WOBBLE_SCALE_RANGE = 0.12;

/** 逗号、句号、顿号也用笔画出来（坐标同 1024 方格，落在字格左下角）；其余标点用字体淡入。 */
const PEN_PUNCTUATION: StrokeData = {
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

function hashString(s: string): number {
  let hash = 0;
  for (const ch of s) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash;
}

/** 小而稳定的伪随机（mulberry32）：同一个种子永远给同一串数。 */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 同一天同一场景总是同一句，换一天换一句；seed 用来让同一天不同位置错开。 */
export function pickQuote(scene: QuoteScene, dateKey: string, seed = ''): Quote {
  const pool = ALL_QUOTES.filter(q => q.scenes.includes(scene));
  if (pool.length === 0) throw new Error(`[handwriting] no quote for scene "${scene}"`);
  return pool[hashString(`${scene}|${dateKey}|${seed}`) % pool.length];
}

function planStrokes(data: CharStrokes, start: number, random: () => number): { strokes: PlannedStroke[]; end: number } {
  const charMs = CHAR_BASE_MS + PER_STROKE_MS * data.m.length;
  const inkMs = charMs * (1 - LIFT_RATIO);
  const liftMs = data.m.length > 1 ? (charMs - inkMs) / (data.m.length - 1) : 0;
  const totalLength = data.m.reduce((sum, [, len]) => sum + len, 0) || 1;
  let cursor = start;
  const strokes = data.m.map(([path, length]) => {
    const rhythm = 1 - RHYTHM_SPREAD / 2 + random() * RHYTHM_SPREAD;
    const durationMs = Math.round(inkMs * (length / totalLength) * rhythm);
    const stroke = { path, length, delayMs: Math.round(cursor), durationMs };
    cursor += durationMs + liftMs;
    return stroke;
  });
  return { strokes, end: cursor - liftMs };
}

function wobble(random: () => number): GlyphWobble {
  return {
    rotate: Math.round((random() * 2 - 1) * WOBBLE_ROTATE_DEG * 10) / 10,
    dy: Math.round((random() * 2 - 1) * WOBBLE_DY_EM * 100) / 100,
    scale: Math.round((WOBBLE_SCALE_MIN + random() * WOBBLE_SCALE_RANGE) * 100) / 100,
  };
}

/** 汉字和逗号句号顿号逐笔写；其余标点、数字、英文和缺数据的字按时间点淡入。 */
export function planWriting(text: string, data: StrokeData): WritingPlan {
  const random = seededRandom(hashString(text));
  const glyphs: PlannedGlyph[] = [];
  let cursor = 0;
  for (const ch of text) {
    const strokes = data[ch] ?? PEN_PUNCTUATION[ch];
    const isPause = PAUSE_CHARS.has(ch);
    if (!strokes) {
      glyphs.push({ kind: 'text', ch, delayMs: Math.round(cursor) });
      cursor += isPause ? PAUSE_MS : CHAR_GAP_MS;
      continue;
    }
    const planned = planStrokes(strokes, cursor, random);
    const narrow = ch in PEN_PUNCTUATION && !(ch in data);
    glyphs.push({ kind: 'pen', ch, narrow, wobble: wobble(random), strokes: planned.strokes });
    cursor = planned.end + (isPause ? PAUSE_MS : CHAR_GAP_MS);
  }
  return { glyphs, totalMs: Math.round(cursor) };
}

/** 按标点把句子切成不可断开的小段：换行只发生在逗号、句号之后，不会把「云帆」拆到两行。 */
export function splitClauses<T extends { ch: string }>(glyphs: T[]): T[][] {
  const clauses: T[][] = [[]];
  for (const g of glyphs) {
    clauses[clauses.length - 1].push(g);
    if (PAUSE_CHARS.has(g.ch)) clauses.push([]);
  }
  return clauses.filter(c => c.length > 0);
}
