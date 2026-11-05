/**
 * 「去看」：打开旁边的浏览器栏，并把画面切到这一家的页面（原来只打开栏，画面停在别家，他找不到要看的那页——2026-11-05 途游投前过目）。
 * 这一家的页面已经关了：服务端把它放回重填（填好了会再出现在「等你」里），这里回一句话给卡片显示；
 * 没有填好过的页面也如实说——点了不能没反应（2026-11-05「去看」点了没反应）。
 */
import { apiPostJson } from '@/api/apiFetch';

import { openLiveDrawer } from '../CareerLiveDrawer';

export const REOPENING_NOTE = '这一家的页面已经关了，正在重新打开并填好，好了会再出现在这里';

/** 返回要在卡片上说的一句话；正常切过去了返回 null。 */
export async function showApplicationPage(applicationId: string | undefined): Promise<string | null> {
  let note: string | null = null;
  if (applicationId) {
    try {
      const res = await apiPostJson<{ ok?: boolean; reopening?: boolean; error?: string }>('/api/career/live/view', { application_id: applicationId });
      if (res?.reopening) note = REOPENING_NOTE;
      else if (res && res.ok === false) note = res.error ?? '这一家的页面打不开了';
    } catch (error) {
      console.warn('[career-live] 去看：切到这一家 FAILED', applicationId, error instanceof Error ? error.message : error);
      note = error instanceof Error && error.message ? error.message : '这一家的页面打不开了';
    }
  }
  openLiveDrawer();
  return note;
}
