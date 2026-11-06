/**
 * 回音归类（inbox-triage）的成果：最近被认出来的几封来信。
 * 一行一封：来信（标题、谁发的）→ 认成什么（一枚章，状态色）→ 挂到了哪家的申请（公司小签）。
 */
import { ArrowRight } from 'lucide-react';

import { CompanyTag } from '../../CompanyMark';
import type { DossierSummary, InboxKind, MailMessage } from '../../types';
import { Stamp, type Tone } from '../visual';

import { ResultList } from './parts';

/** 认得出、对他有下一步的几类；确认信、JD 之类不算回音，不列。 */
export const TRIAGE_STAMP: Partial<Record<InboxKind, { text: string; tone: Tone }>> = {
  interview_invite: { text: '面试邀请', tone: 'success' },
  written_test: { text: '笔试', tone: 'info' },
  assessment: { text: '测评', tone: 'info' },
  offer: { text: 'Offer', tone: 'success' },
  rejection: { text: '不合适', tone: 'neutral' },
};

export interface TriageRow { id: string; subject: string; from: string | null; kind: InboxKind; company: string | null; at: string | null }

/** 收件里认出来的回音 → 一行；挂到申请的用申请那家的公司名。 */
export function triageRows(messages: MailMessage[], dossiers: DossierSummary[]): TriageRow[] {
  return messages.flatMap(message => {
    if (message.direction !== 'in' || !message.kind || !TRIAGE_STAMP[message.kind]) return [];
    const dossier = dossiers.find(row => row.application_id === message.application_id);
    return [{
      id: message.id, subject: message.subject ?? message.snippet ?? '（没有标题）', from: message.from_addr,
      kind: message.kind, company: dossier?.company_name ?? null, at: message.received_at,
    }];
  });
}

function TriageItem({ row }: { row: TriageRow }) {
  const stamp = TRIAGE_STAMP[row.kind];
  return (
    <li className="flex items-center gap-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-[var(--ink)]">{row.subject}</span>
        {row.from && <span className="block truncate text-xs text-[var(--muted)]">{row.from}</span>}
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-[var(--subtle)]" strokeWidth={1.75} aria-hidden />
      <span className="flex w-24 shrink-0">{stamp && <Stamp tone={stamp.tone}>{stamp.text}</Stamp>}</span>
      <span className="flex w-16 shrink-0">{row.company && <CompanyTag name={row.company} />}</span>
    </li>
  );
}

export function TriageList({ rows }: { rows: TriageRow[] }) {
  return (
    <ResultList label="认出来的回音">
      <ul className="divide-y divide-[var(--line)]">{rows.map(row => <TriageItem key={row.id} row={row} />)}</ul>
    </ResultList>
  );
}
