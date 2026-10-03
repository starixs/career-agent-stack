/**
 * 聊天旁的"简历在线编辑"抽屉：不跳页签，在当前对话右侧打开简历编辑器（分区编辑 / 原始 JSON / PDF 预览 / 导出），
 * 可全屏。和浏览器现场抽屉同一套交互，二者同一时间只开一个。
 *  - 打开：助理调用 ui_open(resume_editor) → SSE career:focus {surface:'resume_editor', id}；
 *    或卡片 / 按钮调用 openResumeDrawer(resumeId)。
 *  - 关闭只是收起，已保存的内容不受影响。
 */
import { FileText, Maximize2, Minimize2, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';

import { DRAWER_OPENED_EVENT } from './careerDrawers';
import { Button, LoadingRow } from './CareerPrimitives';

const CareerResume = lazy(() => import('@/pages/CareerResume'));

export const RESUME_DRAWER_EVENT = 'career:resume-drawer';

export function openResumeDrawer(resumeId?: string | null, options: { fullscreen?: boolean } = {}): void {
  emitEvent(RESUME_DRAWER_EVENT, { open: true, resumeId: resumeId ?? null, ...options });
}

export function CareerResumeDrawer() {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);
  // 每次被要求打开都换 key，让编辑器按新的 resumeId 重新选中
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const show = (id: string | null, fs?: boolean) => {
      setResumeId(id);
      setNonce(n => n + 1);
      setOpen(true);
      if (typeof fs === 'boolean') setFullscreen(fs);
      emitEvent(DRAWER_OPENED_EVENT, { name: 'resume' });
    };
    const offOpen = onEvent<{ open?: boolean; resumeId?: string | null; fullscreen?: boolean }>(RESUME_DRAWER_EVENT, p => {
      if (p?.open === false) { setOpen(false); return; }
      show(p?.resumeId ?? null, p?.fullscreen);
    });
    const offFocus = onEvent<{ surface?: string; id?: string | null }>('career:focus', p => {
      if (p?.surface === 'resume_editor') show(p.id ?? null);
    });
    const offOther = onEvent<{ name?: string }>(DRAWER_OPENED_EVENT, p => { if (p?.name !== 'resume') setOpen(false); });
    return () => { offOpen(); offFocus(); offOther(); };
  }, []);

  if (!open) return null;
  return (
    <aside
      data-testid="career-resume-drawer"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      aria-label="简历在线编辑"
      className={`fixed z-40 flex flex-col bg-[var(--paper)] shadow-2xl ${fullscreen ? 'inset-0' : 'inset-y-0 right-0 w-[min(640px,94vw)] border-l border-[var(--line)]'}`}
    >
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2 text-xs text-[var(--ink-muted)]">
        <FileText className="h-3.5 w-3.5" />
        <span className="text-sm font-medium text-[var(--ink)]">简历在线编辑</span>
        <span className="ml-auto">改完点「保存」，助理会读到最新版本</span>
        <Button variant="ghost" onClick={() => setFullscreen(f => !f)} aria-label={fullscreen ? '退出全屏' : '全屏'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setFullscreen(false); }} aria-label="收起简历编辑"><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="flex-1 overflow-auto">
        <Suspense fallback={<LoadingRow />}>
          <CareerResume key={`${resumeId ?? 'default'}:${nonce}`} embedded initialResumeId={resumeId} compact={!fullscreen} />
        </Suspense>
      </div>
    </aside>
  );
}
