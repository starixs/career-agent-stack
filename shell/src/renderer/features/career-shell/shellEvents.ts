/**
 * Events pages raise for actions App owns (bug report overlay).
 * Settings sections and other leaf pages have no App bindings, so they ask App
 * through the renderer event bus instead of threading callbacks.
 */
import { emitEvent } from '@/api/eventBus';

export const OPEN_BUG_REPORT_EVENT = 'career:open-bug-report';

export function requestBugReport(): void {
  emitEvent(OPEN_BUG_REPORT_EVENT, {});
}
