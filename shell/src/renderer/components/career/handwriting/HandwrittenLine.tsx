/**
 * 手写一句话：字形是书法手迹（志莽行书），运笔按楷体笔顺从字形反推——每个字一块画布，墨点按时间表逐个出现。
 * 整句先按原速慢写 2 秒，再平滑加速，6 秒写完；逗号句号处停一下，像换气。墨色用 --hw-ink。
 *
 * 数据（懒加载）：glyphs.json 字形轮廓（scripts/build-handwriting-glyphs.py），strokes.json 楷体笔顺中轴
 * （scripts/build-handwriting-strokes.mjs）。同一个 playKey 每次打开应用只写一遍，之后直接显示写好的样子；
 * prefers-reduced-motion 下也直接显示终态；环境不支持 canvas 时退回文楷文字。
 */
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { RASTER_CELL, canvas2dAvailable, glyphSchedule } from './glyphRaster';
import { PUNCTUATION_STROKES, isPause, lineOffsets, makeWarp, splitClauses } from './handwritingPlan';
import type { CharStrokes, GlyphData, GlyphOutline, InkEvent, StrokeData } from './handwritingPlan';

interface HandwritingData { glyphs: GlyphData; strokes: StrokeData }
interface Painter { ctx: CanvasRenderingContext2D; img: ImageData; events: InkEvent[]; offset: number; next: number }

const writtenThisSession = new Set<string>();
let dataPromise: Promise<HandwritingData> | null = null;

function isCharStrokes(v: unknown): v is CharStrokes {
  if (typeof v !== 'object' || v === null || !('m' in v)) return false;
  return Array.isArray(v.m) && v.m.every(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number');
}

function isGlyphOutline(v: unknown): v is GlyphOutline {
  return typeof v === 'object' && v !== null && 'd' in v && 'adv' in v && typeof v.d === 'string' && typeof v.adv === 'number';
}

function parseStrokeData(raw: unknown): StrokeData {
  if (typeof raw !== 'object' || raw === null) throw new Error('[handwriting] strokes.json is not an object');
  const out: StrokeData = {};
  for (const [ch, value] of Object.entries(raw)) {
    if (!isCharStrokes(value)) throw new Error(`[handwriting] strokes.json has malformed data for "${ch}"`);
    out[ch] = value;
  }
  return out;
}

function parseGlyphData(raw: unknown): GlyphData {
  if (typeof raw !== 'object' || raw === null || !('upm' in raw) || !('ascent' in raw) || !('glyphs' in raw)) throw new Error('[handwriting] glyphs.json is missing upm / ascent / glyphs');
  const { upm, ascent, glyphs } = raw;
  if (typeof upm !== 'number' || typeof ascent !== 'number' || typeof glyphs !== 'object' || glyphs === null) throw new Error('[handwriting] glyphs.json has malformed header');
  const out: GlyphData['glyphs'] = {};
  for (const [ch, value] of Object.entries(glyphs)) {
    if (!isGlyphOutline(value)) throw new Error(`[handwriting] glyphs.json has malformed outline for "${ch}"`);
    out[ch] = value;
  }
  return { upm, ascent, glyphs: out };
}

export function loadHandwritingData(): Promise<HandwritingData> {
  dataPromise ??= Promise.all([import('./glyphs.json'), import('./strokes.json')])
    .then(([g, s]) => ({ glyphs: parseGlyphData(g.default), strokes: parseStrokeData(s.default) }));
  return dataPromise;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** null = 还在加载；'failed' = 加载失败，退回用文楷直接显示文字。 */
function useHandwritingData(): HandwritingData | null | 'failed' {
  const [data, setData] = useState<HandwritingData | null | 'failed'>(null);
  useEffect(() => {
    let alive = true;
    loadHandwritingData().then(
      d => { if (alive) setData(d); },
      (err: unknown) => {
        console.error('[handwriting] FAILED to load handwriting data', err);
        if (alive) setData('failed');
      },
    );
    return () => { alive = false; };
  }, []);
  return data;
}

/** 这句能不能手写：环境有 2D canvas，且每个字都有字形和笔顺（quotes 覆盖由单测保证）。只查表，可在渲染时调用。 */
function canWrite(chars: readonly string[], data: HandwritingData): boolean {
  return canvas2dAvailable() && chars.every(ch => ch in data.glyphs.glyphs && (ch in data.strokes || ch in PUNCTUATION_STROKES));
}

/** 给每块画布配好时间表；拿不到 2D context 或算不出时间表时返回 null。 */
function buildPainters(canvases: HTMLCanvasElement[], chars: string[], data: HandwritingData): { painters: Painter[]; inkEndMs: number } | null {
  const schedules = chars.map(ch => glyphSchedule(ch, data.glyphs, data.strokes));
  const contexts = canvases.map(c => c.getContext('2d'));
  if (schedules.some(s => !s) || contexts.some(c => !c)) return null;
  const { offsets, inkEndMs } = lineOffsets(chars, schedules.map(s => s?.durationMs ?? 0));
  const painters = contexts.flatMap((ctx, i) => (ctx ? [{ ctx, img: ctx.createImageData(RASTER_CELL, RASTER_CELL), events: schedules[i]?.events ?? [], offset: offsets[i], next: 0 }] : []));
  return { painters, inkEndMs };
}

function inkColor(el: HTMLElement): [number, number, number] {
  const [r = 0, g = 0, b = 0] = (getComputedStyle(el).color.match(/\d+/g) ?? []).map(Number);
  return [r, g, b];
}

/** 把每块画布里时间不晚于 upTo（原速毫秒）的墨点画上去；返回是否还有没画完的。 */
function paintUpTo(painters: Painter[], upTo: number, rgb: [number, number, number]): boolean {
  let pending = false;
  for (const p of painters) {
    let changed = false;
    while (p.next < p.events.length && p.events[p.next].t <= upTo - p.offset) {
      const e = p.events[p.next++]; const px = p.img.data;
      px[e.i] = rgb[0]; px[e.i + 1] = rgb[1]; px[e.i + 2] = rgb[2]; px[e.i + 3] = e.a;
      changed = true;
    }
    if (changed) p.ctx.putImageData(p.img, 0, 0);
    if (p.next < p.events.length) pending = true;
  }
  return pending;
}

export function HandwrittenLine({ text, playKey = text, className = '', onWritten }: {
  text: string;
  /** 同一个 key 本次会话只写一遍。 */
  playKey?: string;
  className?: string;
  /** 写完（或不需要写、直接显示终态）时调用一次。 */
  onWritten?: () => void;
}) {
  const data = useHandwritingData();
  const rootRef = useRef<HTMLSpanElement>(null);
  const chars = useMemo(() => [...text], [text]);
  const ready = data !== null && data !== 'failed' && canWrite(chars, data);
  const reportWritten = useEffectEvent(() => onWritten?.());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!data) return;
    // 退回文字（加载失败、不支持 canvas）也算写完，让出处正常出现。
    if (data === 'failed' || !ready || !root) { reportWritten(); return; }
    const built = buildPainters([...root.querySelectorAll('canvas')], chars, data);
    if (!built) {
      console.error('[handwriting] FAILED to prepare glyph canvases', { text });
      reportWritten();
      return;
    }
    const rgb = inkColor(root);
    const animate = !writtenThisSession.has(playKey) && !prefersReducedMotion() && typeof requestAnimationFrame === 'function';
    writtenThisSession.add(playKey);
    if (!animate) { paintUpTo(built.painters, Infinity, rgb); reportWritten(); return; }
    const warp = makeWarp(built.inkEndMs);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      if (paintUpTo(built.painters, warp(now - start), rgb)) frame = requestAnimationFrame(tick);
      else reportWritten();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [data, ready, chars, playKey, text]);

  if (data === 'failed' || (data && !ready)) return <span className={`font-human ${className}`}>{text}</span>;
  const glyphs = chars.map((ch, i) => ({ ch, i }));
  return (
    <span ref={rootRef} role="img" aria-label={text} className={`hw-line ${data ? '' : 'invisible'} ${className}`}>
      {data
        ? splitClauses(glyphs).map(clause => (
          <span key={clause[0].i} className="hw-clause">
            {clause.map(g => (
              <span key={g.i} aria-hidden className={`hw-glyph ${isPause(g.ch) ? 'hw-glyph-narrow' : ''}`}>
                <canvas width={RASTER_CELL} height={RASTER_CELL} />
              </span>
            ))}
          </span>
        ))
        : <span className="font-human">{text}</span>}
    </span>
  );
}
