import { useCallback, useEffect, useRef, useState } from 'react';

import { onEvent } from '@/api/eventBus';

import type { CareerDataChangedEvent } from './types';

export interface CareerQueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 读取求职数据并订阅 `career:data-changed` 自动刷新。
 * - `tables` 为空 → 任意变更都刷新；否则只在变更表与之相交时刷新。
 * - fetcher 用 ref 持有，调用方无需 useCallback。
 */
export function useCareerQuery<T>(fetcher: () => Promise<T>, tables?: readonly string[]): CareerQueryState<T> {
  // 最新 fetcher / tables 存 ref（在 effect 里同步，避免渲染期写 ref），调用方无需 useCallback。
  const fetcherRef = useRef(fetcher);
  const tablesRef = useRef(tables);
  useEffect(() => {
    fetcherRef.current = fetcher;
    tablesRef.current = tables;
  });

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // tick = 请求代数；settledTick = 最近完成的代数。loading 由二者派生，effect 内不同步 setState。
  const [tick, setTick] = useState(0);
  const [settledTick, setSettledTick] = useState(-1);
  const loading = settledTick < tick;
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetcherRef.current()
      .then(result => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSettledTick(tick);
      });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => onEvent<CareerDataChangedEvent>('career:data-changed', payload => {
    const want = tablesRef.current;
    const changed = payload?.tables;
    if (!want || want.length === 0 || !Array.isArray(changed) || changed.length === 0 || changed.some(t => want.includes(t))) {
      reload();
    }
  }), [reload]);

  return { data, loading, error, reload };
}

/** 页面内一次性动作（确认 / 批准 / 保存）的忙碌与错误态。 */
export function useCareerAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
