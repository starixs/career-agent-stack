/**
 * 邮件投递工作台的主区：选中那份申请的四步路（定制简历 → 写邮件 → 等你过目 → 已发出），下面是
 *  - 有一封等他：整封邮件（和卡组同一个 MailSheet、同一套保存）和它的两个按钮，当场办完；没写成 / 没发出去的是失败卡；
 *  - 已发出、有回音：这份的邮件往来。
 * 和 live.png / live-thread.png 那个已确认的版式一样，只是从网申进展页搬到了自己的一页。
 */
import { Loader2 } from 'lucide-react';

import { emitEvent } from '@/api/eventBus';

import type { MailBoardRow, MailDraftView, MailThreadView } from '../../../../shared/careerMailApply';
import { ErrorRow, LoadingRow } from '../CareerPrimitives';
import { mailLabels } from '../delivery/askText';
import { deliveryApi, localMidnightIso } from '../delivery/deliveryApi';
import { useAskActions, type AskOutcome, type Respond } from '../delivery/useAskActions';
import { useCareerQuery } from '../useCareerData';
import { declineMails, needsMailbox, sendMails } from './mailActions';
import type { MailAct } from './MailAskCard';
import { mailApplyApi } from './mailApplyApi';
import { STEP_NAMES, stepsOf, WAITING_PURPOSE } from './mailBoard';
import { MailFailedCard } from './MailFailedCard';
import { MailSheet } from './MailSheet';
import { MailThread } from './MailThread';
import { useMailDrafts } from './useMailDrafts';

/** 办完一封：工作台、等你条、右栏都按这个重取。 */
const changed = () => emitEvent('career:data-changed', { tables: ['action_queue', 'application'] });

const STEP_CLASS = { done: 'on', now: 'run', ask: 'ask', todo: '' } as const;

export function MailSteps({ row }: { row: Pick<MailBoardRow, 'station' | 'waiting'> }) {
  return (
    <ol className="cd-track cm-steps" aria-label="走到哪一步">
      {stepsOf(row).map((state, i) => (
        <li key={STEP_NAMES[i]} className={STEP_CLASS[state]}>
          {state === 'now' ? <Loader2 className="cm-step-spin animate-spin" aria-hidden /> : <i />}
          <span>{STEP_NAMES[i]}</span>
        </li>
      ))}
    </ol>
  );
}

function LetterActions({ row, draft, act, busy, onConnect }: { row: MailBoardRow; draft: MailDraftView; act: MailAct; busy: boolean; onConnect: () => void }) {
  const kind = row.waiting ?? 'apply';
  const purpose = WAITING_PURPOSE[kind];
  const labels = mailLabels(purpose, 1, 1, kind === 'bounced');
  const id = draft.action_id;
  const run = (fn: (respond: Respond) => Promise<AskOutcome>) => void act(fn).then(outcome => { if (outcome) changed(); });
  return (
    <div className="cd-acts">
      {needsMailbox([draft])
        ? <button type="button" className="cd-go" disabled={busy} onClick={onConnect}>连邮箱</button>
        : <button type="button" className="cd-go" disabled={busy || draft.blockers.length > 0} onClick={() => run(respond => sendMails(respond, [id], 1))}>{labels.go}</button>}
      <button type="button" className="cd-later" disabled={busy} onClick={() => run(respond => declineMails(purpose, respond, [id]))}>{labels.later}</button>
    </div>
  );
}

function FailedLetter({ row }: { row: MailBoardRow }) {
  const actions = useAskActions();
  const asks = useCareerQuery(() => deliveryApi.asks(localMidnightIso()).then(r => r.asks));
  const ask = asks.data?.find(a => a.id === row.ask_id);
  if (asks.error) return <ErrorRow message={asks.error} onRetry={asks.reload} />;
  if (!ask?.mail_failed) return asks.data ? null : <LoadingRow />;
  return <MailFailedCard ask={ask} failed={ask.mail_failed} busy={actions.busy} error={actions.error} onAct={fn => actions.act(fn).then(o => { if (o) changed(); return o; })} />;
}

function Letter({ row, actionId, onConnect }: { row: MailBoardRow; actionId: string; onConnect: () => void }) {
  const store = useMailDrafts([actionId]);
  const actions = useAskActions();
  const draft = store.drafts?.[0];
  if (store.error) return <ErrorRow message={store.error} onRetry={store.reload} />;
  if (!draft) return store.drafts ? null : <LoadingRow text="正在取邮件…" />;
  return (
    <div className="cm-ask">
      <MailSheet draft={draft} onPatch={p => store.patch(actionId, p)} onAvailability={store.saveAvailability} onUpload={u => store.upload(actionId, u)} />
      <LetterActions row={row} draft={draft} act={actions.act} busy={actions.busy} onConnect={onConnect} />
      {actions.error && <p role="alert" className="cd-err">{actions.error}</p>}
    </div>
  );
}

function Thread({ applicationId }: { applicationId: string }) {
  const thread = useCareerQuery<MailThreadView>(() => mailApplyApi.thread(applicationId), ['mail_message', 'action_queue']);
  if (thread.error) return <ErrorRow message={thread.error} onRetry={thread.reload} />;
  return thread.data ? <MailThread thread={thread.data} /> : <LoadingRow />;
}

function PaneBody({ row, onConnect }: { row: MailBoardRow; onConnect: () => void }) {
  if (row.station === 'waiting') return row.action_id ? <Letter row={row} actionId={row.action_id} onConnect={onConnect} /> : <FailedLetter row={row} />;
  if ((row.station === 'sent' || row.station === 'replied') && row.application_id) return <Thread applicationId={row.application_id} />;
  return null;
}

export function MailPane({ row, onConnect }: { row: MailBoardRow; onConnect: () => void }) {
  return (
    <section className="cm-pane" aria-label={`${row.company.name} ${row.role}`} data-testid="mail-pane">
      <header className="cm-pane-head">
        <h3 className="font-human">{row.company.name}</h3>
        <span>{row.role}</span>
      </header>
      <MailSteps row={row} />
      <PaneBody row={row} onConnect={onConnect} />
    </section>
  );
}
