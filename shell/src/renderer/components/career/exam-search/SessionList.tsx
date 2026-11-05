/**
 * 记录：一场笔试一行，最近的在上；点开回到那场，前后翻看，也能接着粘。只是自己的记录，不进题库。
 */
import { Trash2 } from 'lucide-react';

import { relativeTime } from '../CareerPrimitives';
import type { ExamSessionSummary } from './examSearchApi';

/** 题干太长时截到这么多字，一行放得下。 */
const STEM_PREVIEW_CHARS = 28;

export function sessionTitle(session: Pick<ExamSessionSummary, 'company_name' | 'role_title' | 'first_stem'>): string {
  const who = [session.company_name, session.role_title].filter(Boolean).join(' · ');
  if (who) return who;
  const stem = session.first_stem ?? '一场笔试';
  return stem.length > STEM_PREVIEW_CHARS ? `${stem.slice(0, STEM_PREVIEW_CHARS)}…` : stem;
}

export function SessionList({ sessions, activeId, onOpen, onRemove }: {
  sessions: ExamSessionSummary[];
  activeId: string | null;
  onOpen: (session: ExamSessionSummary) => void;
  onRemove: (session: ExamSessionSummary) => void;
}) {
  if (sessions.length === 0) return <p className="py-8 text-center text-sm text-[var(--subtle)]">还没有记录。考完一场，回来这里能翻看每道题的答案。</p>;
  return (
    <ul className="divide-y divide-[var(--line)]">
      {sessions.map(session => (
        <li key={session.id} className="group relative">
          <button
            type="button"
            onClick={() => onOpen(session)}
            className={`w-full rounded-md px-3 py-2.5 pr-9 text-left transition-colors hover:bg-[var(--hover)] ${session.id === activeId ? 'bg-[var(--hover)]' : ''}`}
          >
            <span className="block truncate text-sm font-medium text-[var(--ink)]">{sessionTitle(session)}</span>
            <span className="block truncate text-xs text-[var(--muted)]">
              {relativeTime(session.created_at)} · 粘了 {session.search_count} 次 · {session.question_count} 道题
            </span>
          </button>
          <button
            type="button" aria-label="删除这场记录" onClick={() => onRemove(session)}
            className="absolute right-2 top-3 hidden rounded p-1 text-[var(--subtle)] hover:text-[var(--danger)] group-hover:block"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
