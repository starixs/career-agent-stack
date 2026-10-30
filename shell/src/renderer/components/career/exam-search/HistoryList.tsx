/**
 * 搜过的题：最近在上，点开回看；只是自己的记录，不进题库。
 */
import { Trash2 } from 'lucide-react';

import { relativeTime } from '../CareerPrimitives';
import type { ExamSearchRecord } from './examSearchApi';

function titleOf(record: ExamSearchRecord): string {
  const first = record.questions[0]?.stem ?? record.input_text ?? '截图';
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

export function HistoryList({ records, activeId, onOpen, onRemove }: {
  records: ExamSearchRecord[];
  activeId: string | null;
  onOpen: (record: ExamSearchRecord) => void;
  onRemove: (record: ExamSearchRecord) => void;
}) {
  if (records.length === 0) return <p className="text-xs text-[var(--subtle)]">搜过的题会留在这里，考完可以回看。</p>;
  return (
    <ul className="space-y-0.5">
      {records.map(record => (
        <li key={record.id} className="group relative">
          <button
            type="button"
            onClick={() => onOpen(record)}
            className={`w-full rounded-md px-2 py-1.5 pr-7 text-left transition-colors hover:bg-[var(--hover)] ${record.id === activeId ? 'bg-[var(--hover)]' : ''}`}
          >
            <span className="block truncate text-sm text-[var(--ink)]">{titleOf(record)}</span>
            <span className="block truncate text-xs text-[var(--muted)]">
              {[relativeTime(record.created_at), record.company_name, `${record.questions.length} 题`].filter(Boolean).join(' · ')}
              {record.status === 'failed' ? ' · 没答完' : ''}
            </span>
          </button>
          <button
            type="button" aria-label="删除这条记录" onClick={() => onRemove(record)}
            className="absolute right-1 top-1.5 hidden rounded p-1 text-[var(--subtle)] hover:text-[var(--danger)] group-hover:block"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
