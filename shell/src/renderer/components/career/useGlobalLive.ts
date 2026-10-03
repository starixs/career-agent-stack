/**
 * 渲染层 ↔ Global 侧车的长连接（NDJSON）。
 * 不能走 apiFetch：Tauri 里它经 Rust 缓冲代理（不流式、120s 上限）；这里用原生 fetch 直连 Global 端口
 * （CSP 允许 http://127.0.0.1:*，路由带 CORS）。浏览器开发模式下走相对路径（Vite 代理）。
 */
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';

import { isTauri } from '@/api/tauriClient';

import type { LiveStreamEvent } from './types';

export async function globalBaseUrl(): Promise<string> {
  if (!isTauri()) return '';
  try { return (await invoke<string>('cmd_get_global_server_url')).replace(/\/+$/, ''); } catch { return ''; }
}

export interface LiveStreamHandle { close: () => void }
export interface LiveStreamOptions {
  frames: boolean;
  onEvent: (event: LiveStreamEvent) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error', detail?: string) => void;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  baseUrl?: () => Promise<string>;
}

/** 打开长连接，断线自动重连（1s → 2s → … ≤ 15s）。返回 close()。 */
export function connectLiveStream(opts: LiveStreamOptions): LiveStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      opts.onStatus?.('connecting');
      try {
        const base = await (opts.baseUrl ?? globalBaseUrl)();
        const response = await fetchImpl(`${base}/api/career/live/stream?frames=${opts.frames ? 1 : 0}`, { signal: controller.signal, headers: { Accept: 'application/x-ndjson' } });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        opts.onStatus?.('open');
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            try { opts.onEvent(JSON.parse(line) as LiveStreamEvent); } catch { /* 跳过坏行 */ }
          }
        }
        opts.onStatus?.('closed');
      } catch (error) {
        if (closed) break;
        opts.onStatus?.('error', error instanceof Error ? error.message : String(error));
      }
      if (closed) break;
      attempt += 1;
      await new Promise(r => setTimeout(r, Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4))));
    }
  };
  void run();
  return { close: () => { closed = true; controller?.abort(); opts.onStatus?.('closed'); } };
}

/** React 包装：组件挂载期间保持连接。 */
export function useLiveStream(frames: boolean, onEvent: (event: LiveStreamEvent) => void): { status: 'connecting' | 'open' | 'closed' | 'error'; detail: string | null } {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; });
  useEffect(() => {
    const handle = connectLiveStream({ frames, onEvent: ev => onEventRef.current(ev), onStatus: (s, d) => { setStatus(s); setDetail(d ?? null); } });
    return () => handle.close();
  }, [frames]);
  return { status, detail };
}
