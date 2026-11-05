/**
 * 回来卡（规范 §5.6）：离开超过半天再打开，对话最新处出一张简报。三段：要你定的（最急的一件放最大，点一次开始处理）、
 * 已办完的（数字 + 类别 + 公司小签；拒信只计数）、替你挡掉的（填好了停在提交前、没你点头不交的份数）；末尾一句「其余 N 家还没回音」。
 *
 * 「离开」按这台电脑上最后一次看着对话的时间算（窗口可见时每分钟记一次），只存本机。
 * 要你的事和等你条是同一份服务端数据：页面上刚处理掉的不进卡。
 */
import { useEffect, useState } from 'react';

import { emitEvent } from '@/api/eventBus';

import { dueText } from './askText';
import { CompanyPoster } from './CompanyPoster';
import { deliveryApi, type AwayView } from './deliveryApi';

import './delivery.css';

const LAST_SEEN_KEY = 'career.lastSeenAt';
/** 离开多久算「回来」：半天（规范 §5.6）。 */
export const AWAY_THRESHOLD_MS = 12 * 3_600_000;
const HEARTBEAT_MS = 60_000;
/** 卡组从回来卡「从最急的开始」打开时发的事件（等你条订阅）。 */
export const OPEN_DECK_EVENT = 'career:open-deck';

function readLastSeen(): number | null {
  try { const v = Number(window.localStorage.getItem(LAST_SEEN_KEY)); return Number.isFinite(v) && v > 0 ? v : null; } catch (e) {
    console.warn('[career] lastSeen 读不到（隐私模式？）', e); return null;
  }
}
function writeLastSeen(at: number): void {
  try { window.localStorage.setItem(LAST_SEEN_KEY, String(at)); } catch (e) { console.warn('[career] lastSeen 写不进去', e); }
}

/** 打开时读上次离开的时间，之后窗口可见时持续记「还在」。离开够久才返回 since。 */
export function useAwaySince(now = Date.now): string | null {
  const [since] = useState(() => {
    const prev = readLastSeen();
    return prev !== null && now() - prev >= AWAY_THRESHOLD_MS ? new Date(prev).toISOString() : null;
  });
  useEffect(() => {
    const beat = () => { if (document.visibilityState === 'visible') writeLastSeen(Date.now()); };
    beat();
    const t = window.setInterval(beat, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', beat);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', beat); };
  }, []);
  return since;
}

/** 「2 天」「3 周」「14 小时」。 */
export function spanText(sinceIso: string, now = Date.now()): string {
  const hours = Math.max(1, Math.round((now - Date.parse(sinceIso)) / 3_600_000));
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return days < 14 ? `${days} 天` : `${Math.round(days / 7)} 周`;
}

export function ReturnCard({ away, onStart, onClose }: { away: AwayView; onStart?: (askId: string) => void; onClose?: () => void }) {
  const first = away.asks[0];
  return (
    <article className="cd-return cd-root" data-testid="return-card">
      <p className="cd-return-span">你不在的 {spanText(away.since)}{onClose && <button type="button" className="cd-return-close" onClick={onClose}>收起</button>}</p>
      {first ? (
        <div className="cd-return-lead">
          {first.companies[0] && <CompanyPoster company={first.companies[0]} size="lg" state="ask" role={first.role} />}
          <div>
            <h3 className="font-human">{first.title}</h3>
            {dueText(first) && <p className="cd-due cd-due-xl">{dueText(first)}</p>}
            <button type="button" className="cd-go" onClick={() => onStart?.(first.id)}>从最急的开始</button>
            {away.asks.length > 1 && <p className="cd-return-more">还有 {away.asks.length - 1} 件等你</p>}
          </div>
        </div>
      ) : <h3 className="cd-return-none font-human">没有要你做的事</h3>}
      {(away.sent.length > 0 || away.replies.length > 0) && (
        <div className="cd-return-facts">
          {away.sent.length > 0 && (
            <div><span className="cd-fact-n">{away.sent.length}</span><span className="cd-fact-l">已投出</span>
              <span className="cd-fact-row">{away.sent.map(c => <CompanyPoster key={c.name} company={c} size="xs" />)}</span></div>
          )}
          {away.replies.map(r => (
            <div key={r.kind}><span className="cd-fact-n">{r.n}</span><span className="cd-fact-l">{r.label}</span>
              <span className="cd-fact-row">{r.companies.map(c => <CompanyPoster key={c.name} company={c} size="xs" />)}</span></div>
          ))}
        </div>
      )}
      {away.held > 0 && <p className="cd-return-quiet" data-testid="return-held">{away.held} 份填好了，等你投出</p>}
      {away.quiet > 0 && <p className="cd-return-quiet">其余 {away.quiet} 家还没回音。</p>}
    </article>
  );
}

/** 对话底部：离开够久才取数出卡；你发了新消息或点了收起就收起。 */
export function ReturnBriefing({ messageCount }: { messageCount: number }) {
  const since = useAwaySince();
  const [away, setAway] = useState<AwayView | null>(null);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [baseCount] = useState(messageCount);
  useEffect(() => {
    if (!since) return;
    deliveryApi.away(since).then(setAway, (e: unknown) => console.error('[career] away FAILED', since, e));
  }, [since]);
  if (!away || closedAt !== null || messageCount > baseCount) return null;
  return <ReturnCard away={away} onStart={id => emitEvent(OPEN_DECK_EVENT, { id })} onClose={() => setClosedAt(Date.now())} />;
}
