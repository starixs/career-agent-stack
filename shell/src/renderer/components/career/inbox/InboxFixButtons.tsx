/**
 * 通知中心里一封信归档后的两个一键修正（立场 9：点一下，不写一段话说明）：
 *  - PickApplication：同一家几份在投、对不上是哪一份，候选逐个列成按钮；
 *  - NotRight：读错了，点「不对」再选正确的类型（面试邀请 / 笔试 / 测评 / 拒信 / Offer / 无关）。
 * 对话里 inbox_capture 出的「归到哪一份」卡（pick_application）也用 PickApplication。
 */
import { useState } from 'react';

import { careerApi } from '../careerApi';
import { Button, ErrorRow } from '../CareerPrimitives';
import type { CorrectKind, InboxKind } from '../types';
import { useCareerAction } from '../useCareerData';

export interface ApplicationChoice { application_id: string; label: string }

export function PickApplication({ inboxId, choices, onDone }: { inboxId: string; choices: ApplicationChoice[]; onDone: (label: string) => void }) {
  const act = useCareerAction();
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="pick-application">
      <span className="text-xs text-[var(--muted)]">归到哪一份？</span>
      {choices.map(c => (
        <Button key={c.application_id} size="sm" busy={act.busy} onClick={() => void act.run(async () => { await careerApi.assignInbox(inboxId, c.application_id); onDone(`已归到 ${c.label}`); })}>{c.label}</Button>
      ))}
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

const CHOICES: Array<{ kind: CorrectKind; label: string }> = [
  { kind: 'interview_invite', label: '面试邀请' },
  { kind: 'written_test', label: '笔试' },
  { kind: 'assessment', label: '测评' },
  { kind: 'rejection', label: '拒信' },
  { kind: 'offer', label: 'Offer' },
  { kind: 'ignored', label: '和求职无关' },
];

export function NotRight({ inboxId, current, onDone }: { inboxId: string; current: InboxKind | null; onDone: (label: string) => void }) {
  const [open, setOpen] = useState(false);
  const act = useCareerAction();
  if (!open) return <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>不对</Button>;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="not-right">
      <span className="text-xs text-[var(--muted)]">其实是</span>
      {CHOICES.filter(c => c.kind !== current).map(c => (
        <Button key={c.kind} size="sm" busy={act.busy} onClick={() => void act.run(async () => { await careerApi.correctInbox(inboxId, c.kind); onDone(`已改成${c.label}`); })}>{c.label}</Button>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>算了</Button>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}

/** 对话里的「归到哪一份」卡（inbox_capture 对不上是哪一份时出）：点一下就归档，卡片收起。 */
export function PickApplicationCard({ inboxId, title, choices, onDone }: { inboxId: string; title: string; choices: ApplicationChoice[]; onDone: () => void }) {
  return (
    <div data-testid="career-card-pick_application" className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
      <div className="mb-2 text-sm font-medium text-[var(--ink)]">{title}</div>
      <PickApplication inboxId={inboxId} choices={choices} onDone={onDone} />
    </div>
  );
}
