/**
 * 常驻的 Global 事件桥（不带画面）：把批量投递进度 / 接管状态 / 数据变更从 Global 侧车转发到本地 eventBus，
 * 这样接管条、看板、任务列表不用关心事件来自哪个侧车。页面关掉也不影响——它挂在 App 根上。
 */
import { useCallback, useEffect } from 'react';

import { emitEvent } from '@/api/eventBus';

import { installFocusTracking, returnFocusIfStolen } from './focusGuard';
import type { LiveStreamEvent } from './types';
import { useLiveStream } from './useGlobalLive';

const FORWARD_PREFIX = 'career:';

export function CareerLiveBridge() {
  useEffect(() => { installFocusTracking(); }, []);
  const onEvent = useCallback((ev: LiveStreamEvent) => {
    // 焦点守卫：托管 Chrome 开新页抢走了产品窗口的焦点就拿回来（见 focusGuard.ts）
    if (ev.type === 'career:browser-window') { void returnFocusIfStolen(); return; }
    if (ev.type === 'snapshot') {
      const snap = ev as LiveStreamEvent & { batch?: unknown };
      if (snap.batch) emitEvent('career:batch', snap.batch);
      return;
    }
    if (typeof ev.type === 'string' && ev.type.startsWith(FORWARD_PREFIX)) emitEvent(ev.type, ev);
  }, []);
  useLiveStream(false, onEvent);
  return null;
}
