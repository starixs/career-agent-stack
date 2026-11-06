/**
 * 招呼语（greeting）的成果：写过的每一句，挂在哪家的哪个岗位上。
 * 招呼语进的是待办队列（send_greeting）：批准后要他自己发出去的，用和通知中心同一个「原文 + 复制 + 我已发送」；
 * 还在等他批准的只摆原文（批准在通知中心做，这里不重复一个入口）。
 */
import { CompanyTag } from '../../CompanyMark';
import { ManualSendText } from '../../ManualSendText';
import { manualSendText } from '../../manualSendActions';
import type { ActionQueueItem, DossierSummary } from '../../types';
import { dict, parseJson, pickText } from '../read';

import { ResultList } from './parts';

export interface GreetingRow { id: string; company: string | null; title: string | null; text: string; manual: boolean }

/** 队列里的招呼语 → 一行；拿不到原文的跳过。 */
export function greetingRows(actions: ActionQueueItem[], dossiers: DossierSummary[]): GreetingRow[] {
  return actions.filter(action => action.kind === 'send_greeting').flatMap(action => {
    const text = manualSendText(action) ?? pickText(dict(parseJson(action.payload_json, `action ${action.id}.payload_json`)), 'greeting');
    if (!text) return [];
    const dossier = dossiers.find(row => row.application_id === action.application_id);
    return [{ id: action.id, company: dossier?.company_name ?? null, title: dossier?.title ?? null, text, manual: action.status === 'needs_user' }];
  });
}

function GreetingItem({ row, onSent }: { row: GreetingRow; onSent: () => void }) {
  return (
    <div className="space-y-1 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {row.company && <CompanyTag name={row.company} />}
        {row.title && <span className="min-w-0 truncate text-sm text-[var(--ink-2)]">{row.title}</span>}
      </div>
      {row.manual
        ? <ManualSendText text={row.text} actionId={row.id} onSent={onSent} />
        : <div className="mt-1.5 whitespace-pre-wrap break-words rounded-[4px] bg-[var(--inset)] px-3 py-2 text-sm leading-relaxed text-[var(--ink)]">{row.text}</div>}
    </div>
  );
}

export function GreetingList({ rows, onSent }: { rows: GreetingRow[]; onSent: () => void }) {
  return (
    <ResultList label="写过的招呼语">
      {rows.map(row => <GreetingItem key={row.id} row={row} onSent={onSent} />)}
    </ResultList>
  );
}
