/**
 * 等你条的数据：服务端排好的要你的事 + 今天这批的进度。数据变了（career:data-changed / career:batch）就重取；
 * 期限会随时间变急、过了时间会改问「考了吗」，所以每分钟也重取一次。
 *
 * 本地只做两件事：刚处理掉的先藏起来（等服务端下次派生自然没有）；点了「晚点」的挪到队尾（只在这次打开期间）。
 */
import { useEffect, useMemo, useState } from 'react';

import { onEvent } from '@/api/eventBus';

import { useCareerQuery } from '../useCareerData';
import { deliveryApi, localMidnightIso, type AskView } from './deliveryApi';

/** 期限的措辞（今天 / 今晚 / 过了时间）按分钟变，重取间隔取一分钟。 */
const REFRESH_MS = 60_000;

/** 服务端顺序，去掉刚处理的，挪后的放到最后（保持它们之间原来的先后）。 */
export function deckOrder(asks: readonly AskView[], resolved: ReadonlySet<string>, snoozed: readonly string[]): AskView[] {
  const live = asks.filter(a => !resolved.has(a.id));
  const later = snoozed.map(id => live.find(a => a.id === id)).filter((a): a is AskView => !!a);
  return [...live.filter(a => !snoozed.includes(a.id)), ...later];
}

export function useWaitingAsks() {
  const query = useCareerQuery(() => deliveryApi.asks(localMidnightIso()));
  const { reload } = query;
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [snoozed, setSnoozed] = useState<string[]>([]);
  useEffect(() => onEvent('career:batch', () => reload()), [reload]);
  useEffect(() => { const t = window.setInterval(reload, REFRESH_MS); return () => window.clearInterval(t); }, [reload]);
  const asks = useMemo(() => deckOrder(query.data?.asks ?? [], resolved, snoozed), [query.data, resolved, snoozed]);
  return {
    asks,
    run: query.data?.run ?? null,
    error: query.error,
    resolve: (id: string) => { setResolved(s => new Set(s).add(id)); reload(); },
    snooze: (id: string) => setSnoozed(s => [...s.filter(x => x !== id), id]),
  };
}
