/**
 * 现场窗操作的发送队列：所有操作排成一条、按发生顺序一个一个发，还没发出去的同类操作合并。
 *
 * 2026-11-05「在这个浏览器会话里交互非常卡顿，正常 Chrome 很顺」：触控板一秒六十个滚轮事件，每个都单独发一个请求、同时在路上，
 * 后面的排在前面的后头、越积越多；打字一个字一个请求、也同时在路上，快了还会乱序。现在：
 *  - 连着打的字合成一次写入；
 *  - 滚轮在等的时候把位移累加，轮到时一次滚到位；
 *  - 拖动只保留最新位置；
 *  - 点击、按键、按下 / 松开不合并，保持顺序。
 */
export type LiveInput = {
  type: 'click' | 'move' | 'down' | 'up' | 'wheel' | 'type' | 'press';
  x?: number; y?: number; dx?: number; dy?: number; text?: string; key?: string; double?: boolean; clickCount?: number;
  frame?: { width: number; height: number };
};

interface Item { input: LiveInput; done: Array<() => void> }

/** 能并进上一条还没发的操作就并进去（返回 true）。 */
function mergeInto(last: Item | undefined, next: LiveInput): boolean {
  if (!last) return false;
  const a = last.input;
  if (a.type === 'type' && next.type === 'type') { last.input = { ...a, text: `${a.text ?? ''}${next.text ?? ''}` }; return true; }
  if (a.type === 'wheel' && next.type === 'wheel') { last.input = { ...a, dx: (a.dx ?? 0) + (next.dx ?? 0), dy: (a.dy ?? 0) + (next.dy ?? 0), frame: next.frame ?? a.frame }; return true; }
  if (a.type === 'move' && next.type === 'move') { last.input = next; return true; }
  return false;
}

/** 返回 enqueue：操作发出（或并进的那条发出）后 resolve；发送失败由 send 自己处理（不抛给调用方）。 */
export function createLiveInputQueue(send: (input: LiveInput) => Promise<void>): (input: LiveInput) => Promise<void> {
  const waiting: Item[] = [];
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        const item = waiting.shift()!;
        try { await send(item.input); }
        catch (error) { console.warn('[career-live] 现场操作发送 FAILED', item.input.type, error instanceof Error ? error.message : error); }
        finally { for (const d of item.done) d(); }
      }
    } finally { pumping = false; }
  };
  return input => new Promise<void>(resolve => {
    const last = waiting.at(-1);
    if (mergeInto(last, input)) last!.done.push(resolve);
    else waiting.push({ input, done: [resolve] });
    void pump();
  });
}
