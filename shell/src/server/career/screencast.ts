/**
 * 浏览器现场直播：用 CDP `Page.startScreencast` 从托管 Chrome 的当前页拿 JPEG 帧，推给渲染层的"现场窗"。
 * 一个页面只开一路 screencast，多个订阅者共享；最后一个订阅者离开就停，不白耗 CPU。
 * 只读：看不等于控；接管 / 交回仍走控制权接口。
 */
export interface ScreencastFrame { data: string; width: number; height: number; ts: number; url?: string; title?: string }
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'Page.screencastFrame', listener: (ev: { data: string; sessionId: number; metadata: { deviceWidth?: number; deviceHeight?: number; timestamp?: number } }) => void): unknown;
  off?(event: 'Page.screencastFrame', listener: (...args: never[]) => void): unknown;
  detach(): Promise<void>;
}
export interface ScreencastPageLike {
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  newCDPSession(): Promise<CdpSessionLike>;
  /** 页面关闭时通知（playwright: page.once('close', …)）。 */
  onClose?(listener: () => void): void;
}
export interface ScreencastOptions { quality?: number; maxWidth?: number; maxHeight?: number; everyNthFrame?: number; log?: (msg: string) => void }

type Subscriber = (frame: ScreencastFrame) => void;

export class ScreencastHub {
  private subscribers = new Set<Subscriber>();
  private session: CdpSessionLike | null = null;
  private page: ScreencastPageLike | null = null;
  private starting: Promise<void> | null = null;
  private last: ScreencastFrame | null = null;
  constructor(private readonly getPage: () => Promise<ScreencastPageLike | null>, private readonly opts: ScreencastOptions = {}) {}

  get subscriberCount(): number { return this.subscribers.size; }
  lastFrame(): ScreencastFrame | null { return this.last; }

  /** 订阅帧；返回取消函数。首个订阅者触发 screencast 启动。 */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    if (this.last) fn(this.last);
    void this.ensureStarted().catch(() => { /* 启动失败已在 ensureStarted 里记日志；订阅者等下一次 refresh */ });
    return () => {
      this.subscribers.delete(fn);
      if (!this.subscribers.size) void this.stop();
    };
  }

  /** 页面换了（新标签 / 跳转后 Page 对象变化）时由宿主调用。 */
  async refresh(): Promise<void> {
    const page = await this.getPage().catch(() => null);
    if (page && page !== this.page) { await this.stop(); if (this.subscribers.size) await this.ensureStarted().catch(() => { /* 下次 refresh 再试 */ }); }
  }

  private ensureStarted(): Promise<void> {
    if (this.session || this.starting) return this.starting ?? Promise.resolve();
    this.starting = (async () => {
      const page = await this.getPage();
      if (!page || page.isClosed()) throw new Error('没有可直播的浏览器页面');
      const session = await page.newCDPSession();
      session.on('Page.screencastFrame', ev => {
        void session.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => { /* 页面可能已关闭 */ });
        const frame: ScreencastFrame = { data: ev.data, width: ev.metadata.deviceWidth ?? 0, height: ev.metadata.deviceHeight ?? 0, ts: Date.now(), url: page.url() };
        this.last = frame;
        for (const s of this.subscribers) { try { s(frame); } catch { /* 订阅者自己处理 */ } }
      });
      // screencastFrame 事件属于 Page 域，必须先 enable；否则 startScreencast 成功但永远收不到帧
      await session.send('Page.enable').catch(() => { /* 某些实现已默认开启 */ })
      await session.send('Page.startScreencast', { format: 'jpeg', quality: this.opts.quality ?? 55, maxWidth: this.opts.maxWidth ?? 1280, maxHeight: this.opts.maxHeight ?? 900, everyNthFrame: this.opts.everyNthFrame ?? 2 });
      page.onClose?.(() => { void this.stop(); if (this.subscribers.size) setTimeout(() => void this.ensureStarted().catch(() => {}), 500); });
      this.session = session; this.page = page;
      this.opts.log?.('screencast started');
    })().catch(e => { this.opts.log?.(`screencast 启动失败：${e instanceof Error ? e.message : String(e)}`); throw e; }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async stop(): Promise<void> {
    const s = this.session; this.session = null; this.page = null;
    if (!s) return;
    try { await s.send('Page.stopScreencast'); } catch { /* ignore */ }
    try { await s.detach(); } catch { /* ignore */ }
    this.opts.log?.('screencast stopped');
  }
}

/** 把 playwright 的 Page 适配成 ScreencastPageLike。 */
export function fromPlaywrightPage(page: { url(): string; title(): Promise<string>; isClosed(): boolean; context(): { newCDPSession(p: unknown): Promise<unknown> }; once(event: 'close', fn: () => void): unknown }): ScreencastPageLike {
  return {
    url: () => page.url(),
    title: () => page.title(),
    isClosed: () => page.isClosed(),
    newCDPSession: async () => (await page.context().newCDPSession(page)) as CdpSessionLike,
    onClose: fn => { page.once('close', fn); },
  };
}
