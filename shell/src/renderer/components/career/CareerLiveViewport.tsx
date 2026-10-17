/**
 * 浏览器实时画面 + 直接操作层（"云电脑"）：
 *  - 画面来自 Global 侧车 CDP screencast 帧；
 *  - interactive 为 true（用户已接管）时，点击 / 滚轮 / 键盘 / 粘贴转发到托管 Chrome，坐标按帧尺寸换算；
 *  - 未接管时：给了 onRequestControl 就"点画面即接管"——先接管，成功后把这一下点击照常转发；
 *    没给则只看。
 * 「浏览器现场」页签与聊天旁的侧边抽屉共用。
 */
import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type WheelEvent, type ClipboardEvent } from 'react';

import { careerApi } from './careerApi';
import type { LiveFrame } from './types';

const SPECIAL_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** 把 React 键盘事件翻译成 Playwright 的 type / press。返回 null 表示忽略。 */
export function translateKey(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): { type: 'type'; text: string } | { type: 'press'; key: string } | null {
  const mods = [ev.metaKey ? 'Meta' : '', ev.ctrlKey ? 'Control' : '', ev.altKey ? 'Alt' : ''].filter(Boolean);
  if (mods.length) {
    if (ev.key.length === 1) return { type: 'press', key: `${mods.join('+')}+${ev.key.toLowerCase()}` };
    if (SPECIAL_KEYS.has(ev.key)) return { type: 'press', key: `${mods.join('+')}+${ev.key}` };
    return null;
  }
  if (SPECIAL_KEYS.has(ev.key)) return { type: 'press', key: ev.shiftKey && ev.key === 'Tab' ? 'Shift+Tab' : ev.key };
  if (ev.key.length === 1) return { type: 'type', text: ev.key };
  return null;
}

/**
 * 画面框的宽高比：只有和当前比例差超过 2% 才换。实时帧和静止补截图交替到达时，
 * 几像素的尺寸出入不应该让画面框跟着重排、来回跳。
 */
export function stableAspect(current: number | null, width: number | undefined, height: number | undefined): number | null {
  if (!width || !height) return current;
  const next = width / height;
  if (current && Math.abs(next / current - 1) < 0.02) return current;
  return next;
}

export function CareerLiveViewport({ frame, interactive, placeholder, onInputError, onRequestControl, className = '', style }: {
  frame: LiveFrame | null;
  /** 用户已接管：允许转发输入。 */
  interactive: boolean;
  /** 未接管时点画面：先请求接管，返回 true 则继续转发这次点击。 */
  onRequestControl?: () => Promise<boolean>;
  style?: CSSProperties;
  placeholder?: string;
  onInputError?: (message: string) => void;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [aspect, setAspect] = useState<number | null>(() => stableAspect(null, frame?.width, frame?.height));
  // 渲染时按新帧尺寸校正比例（React 的"根据上一次渲染调整状态"写法），差得不多就不动
  const nextAspect = stableAspect(aspect, frame?.width, frame?.height);
  if (nextAspect !== aspect) setAspect(nextAspect);

  const send = useCallback(async (input: Parameters<typeof careerApi.liveInput>[0], label: string) => {
    try { await careerApi.liveInput(input); setLastAction(label); } catch (error) { onInputError?.(error instanceof Error ? error.message : String(error)); }
  }, [onInputError]);

  const frameCoords = (ev: MouseEvent<HTMLElement>) => {
    const el = boxRef.current; if (!el || !frame) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // object-contain：画面按比例居中，先算实际绘制区域
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const drawW = frame.width * scale, drawH = frame.height * scale;
    const offX = rect.left + (rect.width - drawW) / 2, offY = rect.top + (rect.height - drawH) / 2;
    const x = (ev.clientX - offX) / scale, y = (ev.clientY - offY) / scale;
    if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const onClick = (ev: MouseEvent<HTMLDivElement>) => {
    boxRef.current?.focus();
    const c = frameCoords(ev);
    if (!interactive) {
      if (!onRequestControl || !frame || claiming) return;
      const size = { width: frame.width, height: frame.height };
      setClaiming(true);
      void onRequestControl().then(granted => {
        if (granted && c) void send({ type: 'click', ...c, frame: size }, `接管并点击 ${c.x},${c.y}`);
      }).finally(() => setClaiming(false));
      return;
    }
    if (!c) return;
    void send({ type: 'click', ...c, double: ev.detail >= 2, frame: { width: frame!.width, height: frame!.height } }, `点击 ${c.x},${c.y}`);
  };
  const onWheel = (ev: WheelEvent<HTMLDivElement>) => {
    if (!interactive || !frame) return;
    ev.preventDefault();
    void send({ type: 'wheel', dx: Math.round(ev.deltaX), dy: Math.round(ev.deltaY), frame: { width: frame.width, height: frame.height } }, '滚动');
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const t = translateKey(ev);
    if (!t) return;
    ev.preventDefault();
    void send(t.type === 'type' ? { type: 'type', text: t.text } : { type: 'press', key: t.key }, t.type === 'type' ? `输入 ${t.text}` : `按键 ${t.key}`);
  };
  const onPaste = (ev: ClipboardEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const text = ev.clipboardData.getData('text');
    if (!text) return;
    ev.preventDefault();
    void send({ type: 'type', text }, `粘贴 ${text.length} 字`);
  };

  return (
    <div
      ref={boxRef}
      role="application"
      aria-label={interactive ? '浏览器实时画面（可直接操作）' : onRequestControl ? '浏览器实时画面（点击即接管）' : '浏览器实时画面（只读）'}
      tabIndex={0}
      data-testid="live-viewport"
      onClick={onClick}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={`relative overflow-hidden rounded-lg border bg-black/90 outline-none ${interactive ? 'cursor-crosshair' : onRequestControl && frame ? 'cursor-pointer' : 'cursor-default'} ${focused && interactive ? 'border-[var(--primary)] ring-1 ring-[var(--primary)]' : 'border-[var(--line)]'} ${className}`}
      style={{ aspectRatio: aspect ? String(aspect) : '16 / 10', ...style }}
    >
      {frame
        ? <img alt="浏览器实时画面" src={`data:image/jpeg;base64,${frame.data}`} className="h-full w-full select-none object-contain" draggable={false} />
        : <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-white/70">{placeholder ?? '等待画面…'}</div>}
      <div className="pointer-events-none absolute left-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-xs text-white/85">
        {interactive
          ? (focused ? `你在操作${lastAction ? ` · ${lastAction}` : ''}` : '点一下画面开始操作')
          : claiming ? '正在接管…' : onRequestControl && frame ? '助理在操作 · 点画面即可接管' : '只看 · 点「接管」后可直接操作'}
      </div>
    </div>
  );
}
