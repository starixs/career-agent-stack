/**
 * 卡组里「邮件写好了」这一张（face-mail-apply §3.2）：左图右字。
 *  - 一封：左边公司大海报，右边整封邮件（MailSheet）；
 *  - 几封：左边一列可勾选的行（默认全勾），点哪行右边就是哪封。
 * 两个动作：发出（勾了且不差东西的那几封）· 不投这家 / 先收起 / 不跟了 / 我自己回。
 * 还没连邮箱时主按钮是「连邮箱」，打开现有的邮箱连接，连上后重取，按钮变回「发出」。
 */
import { useState } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import type { AskMail, InternAvailability, MailDraftPatch, MailDraftView } from '../../../../shared/careerMailApply';
import { ErrorRow, LoadingRow } from '../CareerPrimitives';
import { mailLabels } from '../delivery/askText';
import { CompanyPoster } from '../delivery/CompanyPoster';
import type { AskView } from '../delivery/deliveryApi';
import type { AskOutcome, Respond } from '../delivery/useAskActions';
import { MailConnectCenter } from '../mail-connect/MailConnectCenter';
import { declineMails, needsMailbox, sendableIds, sendMails } from './mailActions';
import { mailApplyApi } from './mailApplyApi';
import { MailPickList } from './MailPickList';
import { MailSheet } from './MailSheet';
import { useMailDrafts } from './useMailDrafts';

export type MailAct = (fn: (respond: Respond) => Promise<AskOutcome>) => Promise<AskOutcome | null>;

/** 与 className 里的 z-[60] 一致：在卡组之上、邮箱连接弹窗（70）之下。 */
const CONNECT_Z = 60;

function ConnectMailbox({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  useCloseLayer(() => { onClose(); return true; }, CONNECT_Z);
  return (
    <OverlayBackdrop onClose={onClose} className="z-[60] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label="连邮箱" className="cm-connect">
        <MailConnectCenter from="chat" onConnected={onConnected} />
        <button type="button" className="cd-later cm-connect-close" onClick={onClose}>收起</button>
      </div>
    </OverlayBackdrop>
  );
}

function useMailSelection(drafts: readonly MailDraftView[], allIds: readonly string[]) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(allIds));
  const [current, setCurrent] = useState<string | null>(allIds[0] ?? null);
  const shown = drafts.find(d => d.action_id === current) ?? drafts[0] ?? null;
  return { picked, setPicked, shown, show: setCurrent };
}

function MailActions({ ask, mail, drafts, picked, busy, onAct, onSent, onConnect }: {
  ask: AskView; mail: AskMail; drafts: readonly MailDraftView[]; picked: ReadonlySet<string>; busy: boolean;
  onAct: MailAct; onSent: (ids: string[]) => void; onConnect: () => void;
}) {
  const ready = sendableIds(drafts, picked);
  const labels = mailLabels(mail.purpose, ready.length, drafts.length);
  const snooze = mail.purpose === 'apply' && drafts.length > 1;
  const send = async () => {
    const outcome = await onAct(respond => sendMails(respond, ready, drafts.length));
    if (outcome === 'kept') onSent(ready);
  };
  const decline = () => onAct(snooze ? async () => 'snoozed' : respond => declineMails(ask, respond, drafts.map(d => d.action_id)));
  return (
    <div className="cd-acts">
      {needsMailbox(drafts)
        ? <button type="button" className="cd-go" disabled={busy} onClick={onConnect}>连邮箱</button>
        : <button type="button" className="cd-go" disabled={busy || ready.length === 0} onClick={() => void send()}>{labels.go}</button>}
      <button type="button" className="cd-later" disabled={busy} onClick={() => void decline()}>{labels.later}</button>
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
  const patch = (id: string) => async (p: MailDraftPatch) => { store.replace([await mailApplyApi.patch(id, p)]); };
  const saveAvailability = async (v: InternAvailability) => { store.replace(await mailApplyApi.availability(v)); };
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
        {shown && <MailSheet key={shown.action_id} draft={shown} onPatch={patch(shown.action_id)} onAvailability={saveAvailability} />}
        <MailActions ask={ask} mail={mail} drafts={drafts} picked={sel.picked} busy={busy} onAct={onAct}
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
