/**
 * 等你条与卡组（规范 §3、§5.2、§6.3）：要你的事唯一会主动出声的落点，固定在输入框上沿，不随对话滚走。
 *
 *  - 左边「等你 N」+ 前三件的公司小签 + 最急那件的期限（钢笔蓝）；右边今天这批「投出 x / y」和进度格。
 *  - 点开卡组：一次一张，← → 切换，Esc 收起（焦点回到等你条）；新事进来重排后，仍停在正在看的那张。
 *  - 卡组只在一种情况下自己弹出：这件事是你刚说的话引出的（这一轮还在跑），而且你没在输入框里打字。
 *  - 新的要你的事进来时 aria-live 播报一句。
 *  - 没有要你的事、今天也没在投：整条不出现。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { onEvent } from '@/api/eventBus';
import { useTabStateOptional } from '@/context/TabContext';

import { AskCard } from './AskCard';
import { dueText } from './askText';
import { BatchWall } from './BatchWall';
import { CompanyPoster, CountTag } from './CompanyPoster';
import type { AskView, RunView } from './deliveryApi';
import { OPEN_DECK_EVENT } from './ReturnCard';
import { useAskActions } from './useAskActions';
import { useWaitingAsks } from './useWaitingAsks';

import './delivery.css';

/** 等你条上最多几个小签（规范 §5.2）。 */
const DOCK_THUMBS = 3;
/** 进度格最多画几格：一批几百份时一份一格会把整条挤成竖排方块（2026-11-03 实测）。 */
export const METER_MAX_CELLS = 20;

/** 进度格：份数少时一份一格，多了按比例点亮。 */
export function meterCells(done: number, total: number): boolean[] {
  const n = Math.min(Math.max(total, 0), METER_MAX_CELLS);
  const lit = total > 0 ? Math.round((Math.min(done, total) / total) * n) : 0;
  return Array.from({ length: n }, (_, i) => i < lit);
}

function DockBar({ asks, run, onDeck, onRun, dockRef }: { asks: AskView[]; run: RunView | null; onDeck: () => void; onRun: () => void; dockRef: React.RefObject<HTMLButtonElement | null> }) {
  const first = asks[0];
  const due = first ? dueText(first) : null;
  return (
    <div className="cd-dock" data-testid="waiting-dock">
      {first ? (
        <button ref={dockRef} type="button" className="cd-dock-ask" onClick={onDeck} aria-haspopup="dialog">
          <span>等你 <b>{asks.length}</b></span>
          <span className="cd-dock-thumbs">{asks.slice(0, DOCK_THUMBS).map(a => (a.application_ids.length > 1
            ? <CountTag key={a.id} n={a.application_ids.length} />
            : a.companies[0] ? <CompanyPoster key={a.id} company={a.companies[0]} size="xs" state="ask" /> : null))}</span>
          {due && <em>{due}</em>}
        </button>
      ) : <span className="cd-dock-none">没有要你的事</span>}
      {run && (
        <button type="button" className="cd-dock-run" onClick={onRun} aria-label={`今天投出 ${run.done} / ${run.total}，点开看这批`}>
          <span>投出 {run.done} / {run.total}</span>
          <span className="cd-meter" aria-hidden>{meterCells(run.done, run.total).map((on, i) => <i key={i} className={on ? 'on' : ''} />)}</span>
        </button>
      )}
    </div>
  );
}

function Deck({ asks, index, setIndex, onClose, onResolved, onSnoozed }: {
  asks: AskView[]; index: number; setIndex: (i: number) => void; onClose: () => void; onResolved: (id: string) => void; onSnoozed: (id: string) => void;
}) {
  const actions = useAskActions();
  const ask = asks[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') setIndex(Math.min(asks.length - 1, index + 1));
      else if (e.key === 'ArrowLeft') setIndex(Math.max(0, index - 1));
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [asks.length, index, onClose, setIndex]);
  if (!ask) return null;
  const settle = (outcome: Awaited<ReturnType<typeof actions.go>>) => {
    if (outcome === 'resolved') onResolved(ask.id);
    else if (outcome === 'snoozed') onSnoozed(ask.id);
  };
  return (
    <section className="cd-deck" role="dialog" aria-label="等你的事" data-testid="waiting-deck">
      <header className="cd-deck-head">
        <span className="cd-deck-count">等你 <b>{index + 1}</b> / {asks.length}</span>
        <span className="cd-deck-dots" aria-hidden>{asks.map((a, i) => <i key={a.id} className={i === index ? 'on' : ''} />)}</span>
        <span className="cd-deck-nav">
          <button type="button" aria-label="上一件" disabled={index === 0} onClick={() => setIndex(index - 1)}>←</button>
          <button type="button" aria-label="下一件" disabled={index >= asks.length - 1} onClick={() => setIndex(index + 1)}>→</button>
          <button type="button" className="cd-deck-close" onClick={onClose}>收起</button>
        </span>
      </header>
      <AskCard key={ask.id} ask={ask} busy={actions.busy} error={actions.error}
        onGo={values => actions.go(ask, values).then(settle)} onLater={() => actions.later(ask).then(settle)} />
    </section>
  );
}

/** 你在输入框里有没有在打字（有字就不打断）。 */
const isTyping = () => {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.value.trim() !== '';
};

/** 新进来的事：播报一句；是这一轮引出的、你也没在打字，就把卡组翻到它。 */
function useArrivals(asks: AskView[], turnRunning: boolean, openAt: (id: string) => void): string {
  const seen = useRef<Set<string> | null>(null);
  const [announce, setAnnounce] = useState('');
  useEffect(() => {
    const ids = new Set(asks.map(a => a.id));
    const prev = seen.current;
    seen.current = ids;
    if (!prev) return; // 第一次拿到数据不算「新进来」
    const fresh = asks.filter(a => !prev.has(a.id));
    if (!fresh.length) return;
    setAnnounce(`新的要你的事：${fresh.map(a => a.title).join('、')}`);
    if (turnRunning && !isTyping()) openAt(fresh[0].id);
  }, [asks, turnRunning, openAt]);
  return announce;
}

export function WaitingDock() {
  const tab = useTabStateOptional();
  const { asks, run, resolve, snooze } = useWaitingAsks();
  const [deckOpen, setDeckOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  // 按 id 记住正在看哪张：重排后仍停在它上面
  const [currentId, setCurrentId] = useState<string | null>(null);
  const dockRef = useRef<HTMLButtonElement>(null);
  const openAt = useCallback((id: string) => { setCurrentId(id); setDeckOpen(true); setPopOpen(false); }, []);
  const announce = useArrivals(asks, !!tab?.isLoading, openAt);
  // 回来卡「从最急的开始」：打开卡组并定位到那件
  useEffect(() => onEvent<{ id?: string }>(OPEN_DECK_EVENT, p => { if (p?.id) openAt(p.id); }), [openAt]);
  const found = asks.findIndex(a => a.id === currentId);
  const index = found >= 0 ? found : 0;
  if (!asks.length && !run) return <span className="cd-sr" aria-live="polite">{announce}</span>;
  const close = () => { setDeckOpen(false); dockRef.current?.focus(); };
  return (
    <div className="cd-dock-wrap cd-root">
      {deckOpen && asks.length > 0 && (
        <Deck asks={asks} index={index} setIndex={i => setCurrentId(asks[i]?.id ?? null)} onClose={close}
          onResolved={id => { setCurrentId(asks[index + 1]?.id ?? asks[index - 1]?.id ?? null); if (asks.length <= 1) setDeckOpen(false); resolve(id); }}
          onSnoozed={id => { setCurrentId(asks[index + 1]?.id ?? asks[0]?.id ?? null); snooze(id); }} />
      )}
      {popOpen && run && (
        <div className="cd-pop"><BatchWall run={run} compact /><button type="button" className="cd-deck-close" onClick={() => setPopOpen(false)}>收起</button></div>
      )}
      <DockBar asks={asks} run={run} dockRef={dockRef}
        onDeck={() => { setDeckOpen(o => !o); setPopOpen(false); setCurrentId(asks[0]?.id ?? null); }}
        onRun={() => { setPopOpen(o => !o); setDeckOpen(false); }} />
      <span className="cd-sr" aria-live="polite">{announce}</span>
    </div>
  );
}
