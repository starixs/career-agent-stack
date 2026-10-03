/**
 * Global 侧车内部事件总线：批量运行器 / 现场直播把事件发到这里，`/api/career/live/stream` 把它们推给渲染层。
 * 为什么不用 sse.ts 的 broadcast：渲染层只连 Session 侧车的 SSE，Global 的 broadcast 没有任何客户端。
 */
export interface LiveEvent { type: string; ts: number; [key: string]: unknown }
type Listener = (event: LiveEvent) => void;

export class LiveHub {
  private listeners = new Set<Listener>();
  private recent: LiveEvent[] = [];
  constructor(private readonly keep = 50) {}
  publish(type: string, data: Record<string, unknown> = {}): LiveEvent {
    const event: LiveEvent = { ...data, type, ts: Date.now() };
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    for (const l of this.listeners) { try { l(event); } catch { /* 订阅者自己兜 */ } }
    return event;
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** 最近的状态类事件（给新连接补一帧）。 */
  latest(type: string): LiveEvent | undefined {
    for (let i = this.recent.length - 1; i >= 0; i--) if (this.recent[i].type === type) return this.recent[i];
    return undefined;
  }
  get size(): number { return this.listeners.size; }
}

export const liveHub = new LiveHub();
