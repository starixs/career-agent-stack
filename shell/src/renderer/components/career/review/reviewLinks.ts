/** 漏斗与周复盘页的小工具：跳到投递记录、百分比、本地日期。 */
import { emitEvent } from '@/api/eventBus';
import type { CareerFocusEvent } from '@/components/career/types';

/** 在投递记录里只看这一组投递。 */
export function openApplications(label: string, applicationIds: string[]): void {
  emitEvent('career:focus', { surface: 'dossier', origin: 'user', filter: { label, application_ids: applicationIds } } satisfies CareerFocusEvent);
}

export function openApplication(applicationId: string): void {
  emitEvent('career:focus', { surface: 'dossier', origin: 'user', application_id: applicationId } satisfies CareerFocusEvent);
}

export function percent(r: number | null | undefined): string {
  return r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** YYYY-MM-DD → 「10/19」；日期串本身就是本地日期，按 UTC 读避免再偏移。 */
export function shortDate(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
}

/** 时刻 → 「10/24 周五 14:00」，按看板的时区。 */
export function formatMoment(iso: string, tzOffsetMinutes: number): string {
  const d = new Date(Date.parse(iso) + tzOffsetMinutes * 60_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${WEEKDAYS[d.getUTCDay()]} ${hh}:${mm}`;
}
