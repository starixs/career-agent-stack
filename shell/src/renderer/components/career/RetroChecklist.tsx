/**
 * 复盘的「勾一勾」：准备过的深挖点和题列在这里，勾被问到的、卡住的，再点一个整体感觉，就能复盘。
 * 立场 9：面试复盘是只有他知道的事，可以开口说，但也要能用勾选代替打字。
 */
import { useState } from 'react';

import { Button, TextInput } from './CareerPrimitives';
import type { RetroCheckItem } from './types';

type Mark = 'asked' | 'stuck';
const FEELINGS = ['顺利', '一般', '卡得多'] as const;
export type Feeling = typeof FEELINGS[number];

/** 勾选结果拼成交给复盘的一段话；没勾的不写，免得模型当成「没被问到」去推断。 */
export function composeRetro(items: RetroCheckItem[], marks: Record<string, Mark>, feeling: Feeling | null, extra: string): string {
  const asked = items.filter(i => marks[i.key] === 'asked').map(i => i.text);
  const stuck = items.filter(i => marks[i.key] === 'stuck').map(i => i.text);
  return [
    asked.length ? `被问到、答上来了：${asked.join('；')}` : '',
    stuck.length ? `被问到、卡住了：${stuck.join('；')}` : '',
    feeling ? `整体感觉：${feeling}` : '',
    extra.trim() ? `补充：${extra.trim()}` : '',
  ].filter(Boolean).join('。');
}

export function RetroChecklist({ items, onSubmit }: { items: RetroCheckItem[]; onSubmit: (text: string) => void }) {
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [feeling, setFeeling] = useState<Feeling | null>(null);
  const [extra, setExtra] = useState('');
  const toggle = (key: string, mark: Mark) => setMarks(m => {
    const next = { ...m };
    if (next[key] === mark) delete next[key]; else next[key] = mark;
    return next;
  });
  const text = composeRetro(items, marks, feeling, extra);
  return (
    <div className="space-y-2" data-testid="retro-checklist">
      <p className="text-xs text-[var(--muted)]">准备过的这些，哪几条被问到了？</p>
      <ul className="space-y-1.5">
        {items.map(item => (
          <li key={item.key} className="flex items-start gap-2 text-sm">
            <span className="min-w-0 flex-1 text-[var(--ink)]">{item.text}</span>
            {(['asked', 'stuck'] as const).map(mark => (
              <Button key={mark} size="sm" variant={marks[item.key] === mark ? 'primary' : 'ghost'} aria-pressed={marks[item.key] === mark} onClick={() => toggle(item.key, mark)}>
                {mark === 'asked' ? '问到了' : '卡住了'}
              </Button>
            ))}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
        整体
        {FEELINGS.map(f => (
          <Button key={f} size="sm" variant={feeling === f ? 'primary' : 'ghost'} aria-pressed={feeling === f} onClick={() => setFeeling(cur => (cur === f ? null : f))}>{f}</Button>
        ))}
      </div>
      <TextInput value={extra} onChange={e => setExtra(e.target.value)} placeholder="还有没列到的题，可以补一句（不填也行）" aria-label="补充" />
      <Button variant="primary" size="sm" disabled={!text} onClick={() => { onSubmit(text); setMarks({}); setFeeling(null); setExtra(''); }}>开始复盘</Button>
    </div>
  );
}
