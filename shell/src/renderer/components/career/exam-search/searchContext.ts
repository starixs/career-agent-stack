/**
 * 从别的页面（助力记录里某场笔试的「助力」）带着公司和岗位打开搜题页。
 * 页面已挂载时靠事件立刻切换；还没挂载时，挂载后取走一次。
 */
import { emitEvent } from '@/api/eventBus';
import { requestNavigation } from '@/features/career-shell/navModel';

export interface ExamSearchContext { company: string; role: string }

export const EXAM_SEARCH_CONTEXT_EVENT = 'career:exam-search-context';
export const EXAM_SEARCH_VIEW = 'exam-search';

let pending: ExamSearchContext | null = null;

export function openExamSearch(context?: ExamSearchContext): void {
  if (context) {
    pending = context;
    emitEvent(EXAM_SEARCH_CONTEXT_EVENT, context);
  }
  requestNavigation({ kind: 'career-dossier', view: EXAM_SEARCH_VIEW });
}

export function takeExamSearchContext(): ExamSearchContext | null {
  const context = pending;
  pending = null;
  return context;
}
