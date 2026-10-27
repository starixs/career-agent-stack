/**
 * 手写一句话：一支钢笔沿每一笔的笔迹曲线走过去，字带一点歪斜和大小起伏；逗号句号也是画出来的。
 * 写的时候墨是湿的（满色），整句写完后墨色收一点，像墨水干了。颜色用 --hw-ink（蓝黑墨水），
 * 和界面的正文色、钢笔蓝都拉开，一眼看出是「写给你的」而不是界面文字。
 *
 * 笔迹数据是 strokes.json（scripts/build-handwriting-strokes.mjs 从 hanzi-writer-data 抽取，懒加载）。
 * 同一个 playKey 每次打开应用只写一遍，之后直接显示写好的样子；prefers-reduced-motion 下也直接显示终态。
 */
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { planWriting, splitClauses } from './handwritingPlan';
import type { CharStrokes, PlannedGlyph, StrokeData } from './handwritingPlan';

// 笔宽（1024 方格单位）：20px 的字约 1.4px 粗，像一支细钢笔。
const PEN_WIDTH = 72;
// strokes.json 里的长度是采样估算的，虚线段多留 3% 余量，保证收笔处写满。
const DASH_SLACK = 1.03;
const STROKE_EASING = 'cubic-bezier(.35, 0, .25, 1)';
const TEXT_FADE_MS = 280;
// 写完后墨色从满色收到 .hw-line 的终态透明度，用时 1.2 秒。
const INK_SETTLE_MS = 1200;
const WET_INK_OPACITY = 1;

const writtenThisSession = new Set<string>();
let strokeDataPromise: Promise<StrokeData> | null = null;

function isCharStrokes(v: unknown): v is CharStrokes {
  if (typeof v !== 'object' || v === null || !('m' in v)) return false;
  return Array.isArray(v.m) && v.m.every(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number');
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

function PenGlyph({ glyph }: { glyph: Extract<PlannedGlyph, { kind: 'pen' }> }) {
  const { rotate, dy, scale } = glyph.wobble;
  return (
    <svg
      viewBox={glyph.narrow ? '0 0 560 1024' : '0 0 1024 1024'}
      className={`hw-glyph ${glyph.narrow ? 'hw-glyph-narrow' : ''}`}
      style={{ transform: `translateY(${dy}em) rotate(${rotate}deg) scale(${scale})` }}
      aria-hidden
      focusable="false"
    >
      <g transform="translate(0 900) scale(1 -1)">
        {glyph.strokes.map((s, i) => {
          const dash = Math.ceil(s.length * DASH_SLACK);
          return (
            <path
              key={i}
              d={s.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={PEN_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${dash} ${dash + PEN_WIDTH}`}
              strokeDashoffset={0}
              data-hw-from={dash + PEN_WIDTH}
              data-hw-delay={s.delayMs}
              data-hw-duration={s.durationMs}
            />
          );
        })}
      </g>
    </svg>
  );
}

/** 按计划里的 data-hw-* 给每一笔、每个标点排动画，再让整句墨色收干；返回全部结束的 Promise。 */
function animateWriting(root: HTMLElement, totalMs: number): Promise<unknown> {
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
  const settleAt = totalMs / (totalMs + INK_SETTLE_MS);
  runs.push(root.animate(
    [{ opacity: WET_INK_OPACITY }, { opacity: WET_INK_OPACITY, offset: settleAt }, { opacity: getComputedStyle(root).opacity }],
    { duration: totalMs + INK_SETTLE_MS, easing: 'ease-out' },
  ));
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
    animateWriting(root, plan.totalMs).then(
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
            {clause.map((g, gi) => (g.kind === 'pen'
              ? <PenGlyph key={gi} glyph={g} />
              : <span key={gi} aria-hidden className="hw-glyph hw-text font-human" data-hw-fade={g.delayMs}>{g.ch}</span>))}
          </span>
        ))
        : <span className="font-human">{text}</span>}
    </span>
  );
}
