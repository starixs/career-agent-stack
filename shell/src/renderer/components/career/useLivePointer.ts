/**
 * 现场画面里的按下 / 移动 / 松开实时转发到托管 Chrome（face-ga-port 1b：人帮一下留在产品里，要跟手）。
 *
 * 2026-10-31 实例测试：拖动先记轨迹、松手后整段回放，拖的过程中画面一动不动——滑块根本对不准。现在：
 *  - 按下立刻发「按下」；
 *  - 移动只保留最新位置，同一时间最多一个移动请求在路上（不积压旧位置，慢的时候直接跳到最新处）；
 *  - 松开发「松开」；三种事件按发生顺序依次到达（一条串行的发送链）。
 * 按下 + 松开在网页里本身就是一次点击，所以接管期间浏览器补发的 click 由调用方吞掉（consumeClick）。
 */
import { useRef, type MouseEvent } from 'react';

export interface FramePoint { x: number; y: number }
export interface FrameSize { width: number; height: number }
export type LivePointerInput =
  | { type: 'down'; x: number; y: number; clickCount: number; frame: FrameSize }
  | { type: 'move'; x: number; y: number; frame: FrameSize }
  | { type: 'up'; x: number; y: number; frame: FrameSize };

export function useLivePointer(
  send: (input: LivePointerInput) => Promise<void>,
  pointOf: (ev: MouseEvent<HTMLElement>) => FramePoint | null,
  frameSize: () => FrameSize | null,
) {
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pressed = useRef(false);
  const latest = useRef<FramePoint | null>(null);
  const moveQueued = useRef(false);
  const swallowClick = useRef(false);
  const enqueue = (task: () => Promise<void>) => { chain.current = chain.current.then(task, task); };

  const onMouseDown = (ev: MouseEvent<HTMLElement>) => {
    const p = pointOf(ev); const f = frameSize();
    if (ev.button !== 0 || !p || !f) return;
    pressed.current = true; swallowClick.current = true; latest.current = p;
    enqueue(() => send({ type: 'down', ...p, clickCount: Math.max(1, ev.detail || 1), frame: f }));
  };
  const onMouseMove = (ev: MouseEvent<HTMLElement>) => {
    if (!pressed.current) return;
    const p = pointOf(ev); const f = frameSize();
    if (!p || !f) return;
    latest.current = p;
    if (moveQueued.current) return; // 已经排着一个移动：轮到它时取最新位置，不再加
    moveQueued.current = true;
    enqueue(async () => { moveQueued.current = false; const at = latest.current; if (at) await send({ type: 'move', ...at, frame: f }); });
  };
  /** 松开（鼠标移出画面也当松开，免得网页里一直按着）。 */
  const release = (ev: MouseEvent<HTMLElement>) => {
    if (!pressed.current) return;
    pressed.current = false;
    const p = pointOf(ev) ?? latest.current; const f = frameSize();
    if (!p || !f) return;
    enqueue(() => send({ type: 'up', ...p, frame: f }));
  };
  /** 这次 click 是不是刚才按下 / 松开带出来的（已经转发过，调用方别再发一次点击）。 */
  const consumeClick = () => { const s = swallowClick.current; swallowClick.current = false; return s; };
  return { onMouseDown, onMouseMove, onMouseUp: release, onMouseLeave: release, consumeClick };
}
