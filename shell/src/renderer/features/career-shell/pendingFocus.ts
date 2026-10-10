/**
 * career:focus 会让 App 打开对应的面，但那个面可能还没挂载、错过同一个事件。
 * App 把最近一次聚焦存在这里，面挂载时取走一次，用来定位到具体对象。
 */
import type { CareerFocusEvent } from '@/components/career/types';

let pending: CareerFocusEvent | null = null;

export function stashCareerFocus(event: CareerFocusEvent | null | undefined): void {
  pending = event ?? null;
}

/** 取走发给这个面的聚焦（只取一次）。 */
export function takeCareerFocus(surface: CareerFocusEvent['surface']): CareerFocusEvent | null {
  if (!pending || pending.surface !== surface) return null;
  const event = pending;
  pending = null;
  return event;
}
