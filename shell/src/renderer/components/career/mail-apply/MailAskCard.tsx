/**
 * 卡组里「邮件写好了」这一张（face-mail-apply §3.2）：左图右字。
 *  - 一封：左边公司大海报，右边整封邮件（MailSheet）；
 *  - 几封：左边一列可勾选的行（默认全勾），点哪行右边就是哪封。
 * 两个动作：发出（勾了且不差东西的那几封）· 不投这家 / 先收起 / 不跟了 / 我自己回；
 * 几封跟进时多一个安静的「这家不跟了」，只拒绝选中的那一封；
 * 被退回的那封：改好了，重发 · 不投这家（收件人那格标红，改掉才可点）。
 * 还没连邮箱时主按钮是「连邮箱」，打开现有的邮箱连接，连上后重取，按钮变回「发出」。
 */
import { useState } from 'react';

import type { AskMail, MailDraftView } from '../../../../shared/careerMailApply';
import { ErrorRow, LoadingRow } from '../CareerPrimitives';
import { mailLabels } from '../delivery/askText';
import { CompanyPoster } from '../delivery/CompanyPoster';
import type { AskView } from '../delivery/deliveryApi';
import type { AskOutcome, Respond } from '../delivery/useAskActions';
import { ConnectMailbox } from './ConnectMailbox';
import { declineMails, declineOne, needsMailbox, sendableIds, sendMails } from './mailActions';
import { MailPickList } from './MailPickList';
import { MailSheet } from './MailSheet';
import { useMailDrafts } from './useMailDrafts';

export type MailAct = (fn: (respond: Respond) => Promise<AskOutcome>) => Promise<AskOutcome | null>;

function useMailSelection(drafts: readonly MailDraftView[], allIds: readonly string[]) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(allIds));
  const [current, setCurrent] = useState<string | null>(allIds[0] ?? null);
  const shown = drafts.find(d => d.action_id === current) ?? drafts[0] ?? null;
  return { picked, setPicked, shown, show: setCurrent };
}

/** 几封跟进里对选中的那家说「不跟了」：只拒绝那一封（不 drop），其余不受影响。 */
function DropOne({ shown, total, busy, onAct, onGone }: {
  shown: MailDraftView; total: number; busy: boolean; onAct: MailAct; onGone: (ids: string[]) => void;
}) {
  const drop = async () => {
    const id = shown.action_id;
    const outcome = await onAct(respond => declineOne(respond, id, total));
    if (outcome === 'kept') onGone([id]);
  };
  return <button type="button" className="cd-later" disabled={busy} onClick={() => void drop()}>这家不跟了</button>;
}

function MailActions({ mail, drafts, picked, shown, busy, onAct, onSent, onConnect }: {
  mail: AskMail; drafts: readonly MailDraftView[]; picked: ReadonlySet<string>; shown: MailDraftView | null; busy: boolean;
  onAct: MailAct; onSent: (ids: string[]) => void; onConnect: () => void;
}) {
  const ready = sendableIds(drafts, picked);
  const labels = mailLabels(mail.purpose, ready.length, drafts.length, mail.bounced);
  const snooze = drafts.length > 1;
  const send = async () => {
    const outcome = await onAct(respond => sendMails(respond, ready, drafts.length));
    if (outcome === 'kept') onSent(ready);
  };
  const decline = () => onAct(snooze ? async () => 'snoozed' : respond => declineMails(mail.purpose, respond, drafts.map(d => d.action_id)));
  return (
    <div className="cd-acts">
      {needsMailbox(drafts)
        ? <button type="button" className="cd-go" disabled={busy} onClick={onConnect}>连邮箱</button>
        : <button type="button" className="cd-go" disabled={busy || ready.length === 0} onClick={() => void send()}>{labels.go}</button>}
      <button type="button" className="cd-later" disabled={busy} onClick={() => void decline()}>{labels.later}</button>
      {snooze && mail.purpose === 'followup' && shown && <DropOne shown={shown} total={drafts.length} busy={busy} onAct={onAct} onGone={onSent} />}
    </div>
  );
}

function MailAskBody({ ask, mail, drafts, busy, error, onAct, store }: {
  ask: AskView; mail: AskMail; drafts: MailDraftView[]; busy: boolean; error: string | null; onAct: MailAct;
  store: ReturnType<typeof useMailDrafts>;
}) {
  const sel = useMailSelection(drafts, mail.action_ids);
  const [connecting, setConnecting] = useState(false);
  const shown = sel.shown;
  const multi = drafts.length > 1;
  const poster = ask.companies[0];
  return (
    <article className={`cd-ask cd-ask-review cm-ask${multi ? ' cm-ask-multi' : ''}`} data-testid="ask-card-mail">
      <div className="cd-ask-img">
        {multi
          ? <MailPickList drafts={drafts} picked={sel.picked} setPicked={sel.setPicked} current={shown?.action_id ?? null} onShow={sel.show} />
          : poster && <CompanyPoster company={poster} size="lg" state="ask" role={shown?.role ?? ask.role} star={shown?.target} />}
      </div>
      <div className="cd-ask-text">
        <h3 className="cd-ask-title font-human">{ask.title}</h3>
        {shown && <MailSheet key={shown.action_id} draft={shown} onPatch={p => store.patch(shown.action_id, p)}
          onAvailability={store.saveAvailability} onUpload={u => store.upload(shown.action_id, u)} />}
        <MailActions mail={mail} drafts={drafts} picked={sel.picked} shown={shown} busy={busy} onAct={onAct}
          onSent={store.remove} onConnect={() => setConnecting(true)} />
        {error && <p role="alert" className="cd-err">{error}</p>}
      </div>
      {connecting && <ConnectMailbox onClose={() => setConnecting(false)} onConnected={() => { setConnecting(false); store.reload(); }} />}
    </article>
  );
}

export function MailAskCard({ ask, mail, busy, error, onAct }: {
  ask: AskView; mail: AskMail; busy: boolean; error: string | null; onAct: MailAct;
}) {
  const store = useMailDrafts(mail.action_ids);
  if (!store.drafts) {
    return (
      <article className="cd-ask cm-ask" data-testid="ask-card-mail">
        <div className="cd-ask-text">
          <h3 className="cd-ask-title font-human">{ask.title}</h3>
          {store.error ? <ErrorRow message={store.error} onRetry={store.reload} /> : <LoadingRow text="正在取邮件…" />}
        </div>
      </article>
    );
  }
  return <MailAskBody ask={ask} mail={mail} drafts={store.drafts} busy={busy} error={error} onAct={onAct} store={store} />;
}
