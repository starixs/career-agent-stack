/**
 * 手写句子的纯逻辑：选哪一句、每一笔什么时候落笔、写多久。渲染见 HandwrittenLine.tsx。
 *
 * 节奏按「人写字」排：一个字的时长随笔画数增长，字内按笔画长短分配，笔与笔之间留一点提笔的空，
 * 逗号句号处停顿更久，像换气。整句大约每字半秒，十四个字五六秒写完。
 */
import quotes from './quotes.json';

export type QuoteScene = 'daily' | 'done' | 'quiet' | 'setback' | 'start';
export interface Quote { text: string; by?: string; tone: 'encourage' | 'humanist'; scenes: QuoteScene[] }

/** strokes.json 的单字结构：s 为笔画轮廓，m 为 [中轴线路径, 中轴长度]，坐标是 1024 方格、y 轴朝上。 */
export interface CharStrokes { s: string[]; m: Array<[string, number]> }
export type StrokeData = Record<string, CharStrokes>;

export interface PlannedStroke { outline: string; median: string; length: number; delayMs: number; durationMs: number }
export type PlannedGlyph =
  | { kind: 'hanzi'; ch: string; strokes: PlannedStroke[] }
  | { kind: 'text'; ch: string; delayMs: number };
export interface WritingPlan { glyphs: PlannedGlyph[]; totalMs: number }

// 一个字的基础时长 + 每多一笔加的时长：一笔字约 0.2 秒，十笔字约 0.5 秒。
const CHAR_BASE_MS = 180;
const PER_STROKE_MS = 30;
// 字内提笔留白占这个字时长的比例。
const LIFT_RATIO = 0.12;
// 字与字之间、标点处（换气）的停顿。
const CHAR_GAP_MS = 60;
const PAUSE_MS = 260;
const PAUSE_CHARS = new Set(['，', '。', '？', '！', '；', '、']);

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

function planChar(ch: string, data: CharStrokes, start: number): { strokes: PlannedStroke[]; end: number } {
  const charMs = CHAR_BASE_MS + PER_STROKE_MS * data.m.length;
  const inkMs = charMs * (1 - LIFT_RATIO);
  const liftMs = data.m.length > 1 ? (charMs - inkMs) / (data.m.length - 1) : 0;
  const totalLength = data.m.reduce((sum, [, len]) => sum + len, 0) || 1;
  let cursor = start;
  const strokes = data.m.map(([median, length], i) => {
    const durationMs = Math.round(inkMs * (length / totalLength));
    const stroke = { outline: data.s[i], median, length, delayMs: Math.round(cursor), durationMs };
    cursor += durationMs + liftMs;
    return stroke;
  });
  return { strokes, end: start + charMs };
}

/** 有笔画数据的字逐笔写；标点、数字、英文和缺数据的字按时间点淡入。 */
export function planWriting(text: string, data: StrokeData): WritingPlan {
  const glyphs: PlannedGlyph[] = [];
  let cursor = 0;
  for (const ch of text) {
    const strokes = data[ch];
    if (strokes) {
      const planned = planChar(ch, strokes, cursor);
      glyphs.push({ kind: 'hanzi', ch, strokes: planned.strokes });
      cursor = planned.end + CHAR_GAP_MS;
    } else {
      glyphs.push({ kind: 'text', ch, delayMs: Math.round(cursor) });
      cursor += PAUSE_CHARS.has(ch) ? PAUSE_MS : CHAR_GAP_MS;
    }
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
