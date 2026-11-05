/**
 * 「去看」：打开旁边的浏览器栏，并把画面切到这一家的页面（原来只打开栏，画面停在别家，他找不到要看的那页——2026-11-05 途游投前过目）。
 * 这家页面已经关了也照样打开栏，画面留在当前页。
 */
import { apiPostJson } from '@/api/apiFetch';

import { openLiveDrawer } from '../CareerLiveDrawer';

export async function showApplicationPage(applicationId: string | undefined): Promise<void> {
  if (applicationId) {
    await apiPostJson<unknown>('/api/career/live/view', { application_id: applicationId })
      .catch((error: unknown) => console.warn('[career-live] 去看：切到这一家 FAILED', applicationId, error instanceof Error ? error.message : error));
  }
  openLiveDrawer();
}
