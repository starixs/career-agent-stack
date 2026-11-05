/**
 * 网申进展页里的邮件申请（P2.8）：
 *  - MailLiveList：邮件申请一列，带「邮件」小签，点一行选中；
 *  - MailLivePane：选中那份时浏览器画面的位置换成它——上面一条路（定制简历 → 写邮件 → 等你过目 → 已发出），
 *    待发时下面是那封的整张预览（能改，发出仍在卡组里），否则是这份的邮件往来。
 */
import { useCareerQuery } from '../useCareerData';
import { ErrorRow, LoadingRow } from '../CareerPrimitives';
import type { Application } from '../types';
import { deliveryApi, localMidnightIso } from '../delivery/deliveryApi';
import { mailLiveState, mailSteps, mailWaitingApps, pendingApplyMail } from './liveMail';
import { openDeckForMail } from './mailActions';
import { mailApplyApi } from './mailApplyApi';
import { MailSheet } from './MailSheet';
import { MailThread } from './MailThread';
import { useMailDrafts } from './useMailDrafts';

import '../delivery/delivery.css';
import './mail-apply.css';

const appName = (app: Application) => [app.company_name, app.title].filter(Boolean).join(' · ') || '这份申请';

export function MailLiveList({ apps, selected, onSelect }: { apps: readonly Application[]; selected: string | null; onSelect: (id: string) => void }) {
  // 哪份有邮件等他：和等你条同一份数据（一次请求），不逐份取往来
  const asks = useCareerQuery(() => deliveryApi.asks(localMidnightIso()).then(r => r.asks));
  const waiting = mailWaitingApps(asks.data ?? []);
  return (
    <ul className="cm-live-list" aria-label="邮件投递">
      {apps.map(app => {
        const state = mailLiveState(app.stage, waiting.has(app.id));
        return (
          <li key={app.id}>
            <button type="button" className="cm-live-row" aria-pressed={app.id === selected} onClick={() => onSelect(app.id)}>
              <span className="cm-tag">邮件</span>
              <span className="cm-live-name" title={appName(app)}>{appName(app)}</span>
              <span className={`cm-live-state${state.ask ? ' is-ask' : ''}`}>{state.text}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 待发那封：整张预览可改；发出只在卡组里（看过、点发出），这里给一个去卡组的入口。 */
function PendingSheet({ actionId }: { actionId: string }) {
  const store = useMailDrafts([actionId]);
  const draft = store.drafts?.[0];
  if (store.error) return <ErrorRow message={store.error} onRetry={store.reload} />;
  if (!store.drafts) return <LoadingRow text="正在取邮件…" />;
  if (!draft) return null;
  return (
    <>
      <MailSheet draft={draft} onPatch={p => store.patch(actionId, p)} onAvailability={store.saveAvailability} onUpload={u => store.upload(actionId, u)} />
      <div className="cd-acts">
        <button type="button" className="cd-go-text" onClick={() => openDeckForMail([actionId]).catch((e: unknown) => {
          console.error('[career] mail-apply open deck FAILED action=', actionId, e instanceof Error ? e.message : String(e));
        })}>去发出 →</button>
      </div>
    </>
  );
}

export function MailLivePane({ app, onBack }: { app: Application; onBack: () => void }) {
  const thread = useCareerQuery(() => mailApplyApi.thread(app.id), ['mail_message', 'action_queue', 'application']);
  const pending = pendingApplyMail(thread.data);
  return (
    <section className="cm-live cd-root" aria-label={`${appName(app)} 的邮件投递`} data-testid="mail-live-pane">
      <header className="cm-live-head">
        <span className="cm-tag">邮件</span>
        <h3 className="font-human" title={appName(app)}>{appName(app)}</h3>
        <button type="button" className="cd-later" onClick={onBack}>回到画面</button>
      </header>
      <ol className="cd-track" aria-label="走到哪一步">
        {mailSteps(app, thread.data).map(n => (
          <li key={n.key} className={`${n.on ? 'on' : ''} ${n.ask ? 'ask' : ''}`}><i /><span>{n.label}</span></li>
        ))}
      </ol>
      {thread.error && <ErrorRow message={thread.error} onRetry={thread.reload} />}
      {!thread.data && !thread.error && <LoadingRow text="正在取邮件往来…" />}
      {pending ? <PendingSheet key={pending} actionId={pending} /> : thread.data && <MailThread thread={thread.data} />}
    </section>
  );
}
