/**
 * 页面关键位置的一句手写：按场景（今天有事 / 都做完了 / 空闲 / 受挫 / 起步）从内置语句里挑一句，
 * 同一天同一场景固定一句。蓝黑墨水手写，写完后出处淡入。语句库见 quotes.json。
 */
import { useMemo, useState } from 'react';

import { localDateKey } from '@/components/career/todoCalendar';

import { HandwrittenLine } from './HandwrittenLine';
import { pickQuote } from './handwritingPlan';
import type { QuoteScene } from './handwritingPlan';

export function QuoteNote({ scene, seed = '', className = '' }: {
  scene: QuoteScene;
  /** 同一天同一场景出现在两个位置时，用它错开成不同的句子。 */
  seed?: string;
  className?: string;
}) {
  const dateKey = localDateKey(new Date());
  const quote = useMemo(() => pickQuote(scene, dateKey, seed), [scene, dateKey, seed]);
  const [written, setWritten] = useState(false);
  return (
    <figure data-quote-scene={scene} data-quote-tone={quote.tone} className={className}>
      <HandwrittenLine key={quote.text} text={quote.text} playKey={`${scene}|${dateKey}|${quote.text}`} onWritten={() => setWritten(true)} />
      {quote.by && (
        <figcaption className={`mt-1 text-xs text-[var(--muted)] transition-opacity duration-500 motion-reduce:transition-none ${written ? 'opacity-100' : 'opacity-0'}`}>
          {`—— ${quote.by}`}
        </figcaption>
      )}
    </figure>
  );
}
