/**
 * 「改简历」工作面的事件控制器（specs/CAREER_DESIGN.md §5.7）：不渲染任何东西，
 * 只把打开请求变成对话页右栏的简历面板（features/career-shell/workSurfaces.tsx）。
 *  - 打开：助理调用 ui_open(resume_editor) → SSE career:focus {surface:'resume_editor', id}；
 *    或卡片 / 按钮调用 openResumeDrawer(resumeId)。
 *  - 关闭只是收起，已保存的内容不受影响。和浏览器等其他工作面同一时间只展开一个。
 */
import { useEffect } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { requestNavigation } from '@/features/career-shell/navModel';
import { collapseWorkSurface, expandWorkSurface } from '@/features/career-shell/workSurfaceStore';

import { DRAWER_OPENED_EVENT } from './careerDrawers';

export const RESUME_DRAWER_EVENT = 'career:resume-drawer';

export function openResumeDrawer(resumeId?: string | null, options: { fullscreen?: boolean } = {}): void {
  emitEvent(RESUME_DRAWER_EVENT, { open: true, resumeId: resumeId ?? null, ...options });
}

export function CareerResumeDrawer() {
  useEffect(() => {
    const show = (id: string | null, fullscreen?: boolean) => {
      // 工作台三栏需要宽度：未指定时铺满，可以收回右栏
      expandWorkSurface('resume', { refId: id, fullscreen: typeof fullscreen === 'boolean' ? fullscreen : true });
      emitEvent(DRAWER_OPENED_EVENT, { name: 'resume' });
      requestNavigation({ kind: 'chat' });
    };
    const offOpen = onEvent<{ open?: boolean; resumeId?: string | null; fullscreen?: boolean }>(RESUME_DRAWER_EVENT, p => {
      if (p?.open === false) { collapseWorkSurface('resume'); return; }
      show(p?.resumeId ?? null, p?.fullscreen);
    });
    const offFocus = onEvent<{ surface?: string; id?: string | null }>('career:focus', p => {
      if (p?.surface === 'resume_editor') show(p.id ?? null);
    });
    return () => { offOpen(); offFocus(); };
  }, []);
  return null;
}
