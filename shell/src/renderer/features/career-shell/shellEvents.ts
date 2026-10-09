/**
 * Events pages raise for actions App owns (bug report overlay, app routes).
 * Settings sections and other leaf pages have no App bindings, so they ask App
 * through the renderer event bus instead of threading callbacks.
 */
import { emitEvent } from '@/api/eventBus';

import type { AppRoute } from '../../../shared/appRoute';

export const OPEN_BUG_REPORT_EVENT = 'career:open-bug-report';
export const OPEN_APP_ROUTE_EVENT = 'career:open-app-route';

export function requestBugReport(): void {
  emitEvent(OPEN_BUG_REPORT_EVENT, {});
}

export function requestAppRoute(route: AppRoute): void {
  emitEvent(OPEN_APP_ROUTE_EVENT, { route });
}
