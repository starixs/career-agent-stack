/**
 * 产品内选文件：内嵌窗口模式下真实 Chrome 停在屏幕角落，页面里点「上传附件」弹出的系统选文件框
 * 会挂在看不见的窗口上。Registry 用 Playwright 的 filechooser 事件拦下它，交到这里：
 *   1. 发 `career:live-filechooser {state:'open'}` 给渲染层，聊天旁的现场抽屉弹出「选择文件」；
 *   2. 用户在产品里选好文件 → `POST /api/career/live/file` 把内容（base64）交回来 → chooser.setFiles；
 *   3. 取消 / 超时则丢弃，页面保持原样。
 * 同一时刻只保留一个待处理的选文件请求（新的覆盖旧的），与现场画面"只有一页在前台"一致。
 */
import { randomUUID } from 'crypto';

import type { LiveHub } from './live-hub';

export interface FileChooserLike {
  isMultiple(): boolean;
  element(): { getAttribute(name: string): Promise<string | null> };
  page(): { url(): string };
  setFiles(files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void>;
}

export interface PendingFileChooser {
  id: string;
  sessionId: string;
  multiple: boolean;
  accept: string | null;
  url: string;
  ts: number;
}

export interface UploadedFile { name: string; mimeType?: string; data: string }

/** 单次上传总大小上限（网申附件通常 ≤ 10MB；留余量）。 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60_000;

export class FileChooserBroker {
  private pending: (PendingFileChooser & { chooser: FileChooserLike }) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly hub: LiveHub, private readonly ttlMs = DEFAULT_TTL_MS) {}

  current(): PendingFileChooser | null {
    if (!this.pending) return null;
    const { chooser: _chooser, ...info } = this.pending;
    return info;
  }

  async offer(sessionId: string, chooser: FileChooserLike): Promise<PendingFileChooser> {
    const accept = await chooser.element().getAttribute('accept').catch(() => null);
    let url = '';
    try { url = chooser.page().url(); } catch { /* 页面已关闭 */ }
    this.clear();
    const info: PendingFileChooser = { id: randomUUID(), sessionId, multiple: chooser.isMultiple(), accept, url, ts: Date.now() };
    this.pending = { ...info, chooser };
    this.timer = setTimeout(() => { if (this.pending?.id === info.id) this.finish('expired'); }, this.ttlMs);
    this.timer.unref?.();
    this.hub.publish('career:live-filechooser', { ...info, state: 'open' });
    return info;
  }

  async fulfill(id: string, files: UploadedFile[]): Promise<{ count: number; bytes: number }> {
    const pending = this.pending;
    if (!pending || pending.id !== id) throw new Error('这个选文件请求已经失效，请在页面里重新点一次上传');
    if (!files.length) throw new Error('没有选择文件');
    if (!pending.multiple && files.length > 1) throw new Error('这里只能上传一个文件');
    const payload = files.map(f => {
      const name = String(f.name || 'file').replace(/[\\/]/g, '_').slice(0, 200);
      return { name, mimeType: f.mimeType || 'application/octet-stream', buffer: Buffer.from(String(f.data || ''), 'base64') };
    });
    const bytes = payload.reduce((n, f) => n + f.buffer.length, 0);
    if (bytes > MAX_UPLOAD_BYTES) throw new Error(`文件太大（${Math.round(bytes / 1024 / 1024)}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`);
    await pending.chooser.setFiles(payload);
    this.finish('done', { count: payload.length, names: payload.map(f => f.name) });
    return { count: payload.length, bytes };
  }

  cancel(id: string): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    this.finish('cancelled');
    return true;
  }

  private finish(state: 'done' | 'cancelled' | 'expired', extra: Record<string, unknown> = {}): void {
    const pending = this.pending;
    this.clear();
    if (pending) this.hub.publish('career:live-filechooser', { id: pending.id, sessionId: pending.sessionId, state, ...extra });
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
