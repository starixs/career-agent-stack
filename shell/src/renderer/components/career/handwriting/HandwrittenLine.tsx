/**
 * 手写一句话：每个汉字按笔顺，用一道粗墨线沿笔画中轴线画过去，墨线被笔画轮廓裁成字形——
 * 看起来就是一笔一笔写出来的。标点等没有笔画数据的字按时间点淡入。
 *
 * 笔画数据是 strokes.json（scripts/build-handwriting-strokes.mjs 从 hanzi-writer-data 抽取，懒加载）。
 * 同一个 playKey 每次打开应用只写一遍，之后直接显示写好的样子；prefers-reduced-motion 下也直接显示终态。
 */
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { planWriting, splitClauses } from './handwritingPlan';
import type { CharStrokes, PlannedGlyph, StrokeData } from './handwritingPlan';

// 墨线宽度（1024 方格单位）：比最粗的笔画还宽，被轮廓裁剪后正好填满字形。
const INK_WIDTH = 220;
// 笔画中轴的落笔前偏移：整条线连同圆头都藏在起点之前，避免开写前露出一个墨点。
const HIDDEN_OFFSET_PAD = INK_WIDTH / 2 + 4;
const STROKE_EASING = 'cubic-bezier(.45, 0, .3, 1)';
const TEXT_FADE_MS = 280;

const writtenThisSession = new Set<string>();
let strokeDataPromise: Promise<StrokeData> | null = null;

function isCharStrokes(v: unknown): v is CharStrokes {
  if (typeof v !== 'object' || v === null || !('s' in v) || !('m' in v)) return false;
  const { s, m } = v;
  return Array.isArray(s) && Array.isArray(m) && s.length === m.length
    && s.every(p => typeof p === 'string')
    && m.every(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number');
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

export function loadStrokeData(): Promise<StrokeData> {
  strokeDataPromise ??= import('./strokes.json').then(m => parseStrokeData(m.default));
  return strokeDataPromise;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** null = 还在加载；'failed' = 加载失败，退回用文楷直接显示文字。 */
function useStrokeData(): StrokeData | null | 'failed' {
  const [data, setData] = useState<StrokeData | null | 'failed'>(null);
  useEffect(() => {
    let alive = true;
    loadStrokeData().then(
      d => { if (alive) setData(d); },
      (err: unknown) => {
        console.error('[handwriting] FAILED to load stroke data', err);
        if (alive) setData('failed');
      },
    );
    return () => { alive = false; };
  }, []);
  return data;
}

function HanziGlyph({ glyph, uid }: { glyph: Extract<PlannedGlyph, { kind: 'hanzi' }>; uid: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className="hw-glyph" aria-hidden focusable="false">
      <defs>
        {glyph.strokes.map((s, i) => <clipPath key={i} id={`${uid}-${i}`}><path d={s.outline} /></clipPath>)}
      </defs>
      <g transform="translate(0 900) scale(1 -1)">
        {glyph.strokes.map((s, i) => (
          <path
            key={i}
            d={s.median}
            clipPath={`url(#${uid}-${i})`}
            fill="none"
            stroke="currentColor"
            strokeWidth={INK_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${s.length} ${s.length + INK_WIDTH}`}
            strokeDashoffset={0}
            data-hw-from={s.length + HIDDEN_OFFSET_PAD}
            data-hw-delay={s.delayMs}
            data-hw-duration={s.durationMs}
          />
        ))}
      </g>
    </svg>
  );
}

/** 按计划里的 data-hw-* 给每一笔、每个标点排动画；返回最后一个动画结束的 Promise。 */
function animateWriting(root: HTMLElement): Promise<unknown> {
  const runs: Animation[] = [];
  root.querySelectorAll<SVGPathElement>('[data-hw-from]').forEach(el => {
    runs.push(el.animate(
      [{ strokeDashoffset: Number(el.dataset.hwFrom) }, { strokeDashoffset: 0 }],
      { delay: Number(el.dataset.hwDelay), duration: Number(el.dataset.hwDuration), easing: STROKE_EASING, fill: 'backwards' },
    ));
  });
  root.querySelectorAll<HTMLElement>('[data-hw-fade]').forEach(el => {
    runs.push(el.animate([{ opacity: 0 }, { opacity: 1 }], { delay: Number(el.dataset.hwFade), duration: TEXT_FADE_MS, fill: 'backwards' }));
  });
  return Promise.all(runs.map(a => a.finished));
}

export function HandwrittenLine({ text, playKey = text, className = '', onWritten }: {
  text: string;
  /** 同一个 key 本次会话只写一遍。 */
  playKey?: string;
  className?: string;
  /** 写完（或不需要写、直接显示终态）时调用一次。 */
  onWritten?: () => void;
}) {
  const data = useStrokeData();
  const uid = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLSpanElement>(null);
  const plan = useMemo(() => (data && data !== 'failed' ? planWriting(text, data) : null), [text, data]);
  const reportWritten = useEffectEvent(() => onWritten?.());

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!plan || !root) return;
    const animate = !writtenThisSession.has(playKey) && !prefersReducedMotion() && typeof root.animate === 'function';
    writtenThisSession.add(playKey);
    if (!animate) { reportWritten(); return; }
    let alive = true;
    animateWriting(root).then(
      () => { if (alive) reportWritten(); },
      (err: unknown) => {
        // 卸载或换句时动画被 cancel()，finished 以 AbortError 结束，属正常；其余照实上报。
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('[handwriting] FAILED while animating', { text }, err);
      },
    );
    return () => { alive = false; root.getAnimations?.({ subtree: true }).forEach(a => a.cancel()); };
  }, [plan, playKey, text]);

  if (data === 'failed') return <span className={`font-human ${className}`}>{text}</span>;
  return (
    <span ref={rootRef} role="img" aria-label={text} className={`hw-line ${plan ? '' : 'invisible'} ${className}`}>
      {plan
        ? splitClauses(plan.glyphs).map((clause, ci) => (
          <span key={ci} className="hw-clause">
            {clause.map((g, gi) => (g.kind === 'hanzi'
              ? <HanziGlyph key={gi} glyph={g} uid={`${uid}-${ci}-${gi}`} />
              : <span key={gi} aria-hidden className="hw-glyph hw-text font-human" data-hw-fade={g.delayMs}>{g.ch}</span>))}
          </span>
        ))
        : <span className="font-human">{text}</span>}
    </span>
  );
}
