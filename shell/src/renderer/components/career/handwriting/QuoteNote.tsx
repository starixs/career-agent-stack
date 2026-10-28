/**
 * 页面关键位置的一句手写：按场景从内置语句里挑一句（语句库见 quotes.json），志莽行书写出，写完后出处淡入。
 * pick = 'daily'：同一天同一场景固定一句（今天栏）。
 * pick = 'random'：每次打开随机一句，不与本机上一次在这个场景显示的重复（漏斗页按求职状态播放）。
 */
import { useEffect, useMemo, useState } from 'react';

import { localDateKey } from '@/components/career/todoCalendar';

import { HandwrittenLine } from './HandwrittenLine';
import { pickQuote, pickRandomQuote } from './handwritingPlan';
import type { Quote, QuoteScene } from './handwritingPlan';

// 每个场景上一次显示的句子，记在本机，只用来避免连着两次看到同一句。
const LAST_QUOTE_KEY_PREFIX = 'career:quote-last:';

function readLastQuote(scene: QuoteScene): string | null {
  try {
    return window.localStorage.getItem(LAST_QUOTE_KEY_PREFIX + scene);
  } catch (err) {
    console.warn('[handwriting] cannot read last quote, repeats are possible', { scene }, err);
    return null;
  }
}

function rememberLastQuote(scene: QuoteScene, text: string): void {
  try {
    window.localStorage.setItem(LAST_QUOTE_KEY_PREFIX + scene, text);
  } catch (err) {
    console.warn('[handwriting] cannot remember last quote, next visit may repeat it', { scene }, err);
  }
}

function WrittenQuote({ scene, quote, playKey, className }: { scene: QuoteScene; quote: Quote; playKey: string; className: string }) {
  const [written, setWritten] = useState(false);
  return (
    <figure data-quote-scene={scene} data-quote-tone={quote.tone} className={className}>
      <HandwrittenLine key={quote.text} text={quote.text} playKey={playKey} onWritten={() => setWritten(true)} />
      {quote.by && (
        <figcaption className={`mt-1 text-xs text-[var(--muted)] transition-opacity duration-500 motion-reduce:transition-none ${written ? 'opacity-100' : 'opacity-0'}`}>
          {`—— ${quote.by}`}
        </figcaption>
      )}
    </figure>
  );
}

function DailyQuote({ scene, seed, className }: { scene: QuoteScene; seed: string; className: string }) {
  const dateKey = localDateKey(new Date());
  const quote = useMemo(() => pickQuote(scene, dateKey, seed), [scene, dateKey, seed]);
  return <WrittenQuote scene={scene} quote={quote} playKey={`${scene}|${dateKey}|${quote.text}`} className={className} />;
}

/** 挂载时挑一次；场景变了由外层按 key 重新挂载。 */
function RandomQuote({ scene, className }: { scene: QuoteScene; className: string }) {
  const [quote] = useState(() => pickRandomQuote(scene, readLastQuote(scene)));
  useEffect(() => { rememberLastQuote(scene, quote.text); }, [scene, quote.text]);
  return <WrittenQuote scene={scene} quote={quote} playKey={`${scene}|random|${quote.text}`} className={className} />;
}

export function QuoteNote({ scene, seed = '', pick = 'daily', className = '' }: {
  scene: QuoteScene;
  /** 同一天同一场景出现在两个位置时，用它错开成不同的句子（只对 daily 有效）。 */
  seed?: string;
  pick?: 'daily' | 'random';
  className?: string;
}) {
  return pick === 'random'
    ? <RandomQuote key={scene} scene={scene} className={className} />
    : <DailyQuote scene={scene} seed={seed} className={className} />;
}
