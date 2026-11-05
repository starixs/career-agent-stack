/**
 * 卡组里「N 封没写成 / 没发出去」这一张（F5）：左图右字，两个动作，没有「我自己来」。
 *  - 没写成：再写一次 · 晚点；
 *  - 没发出去：再发一次（放回待发，卡组翻到重新出现的那件，他看着点发出）· 晚点；
 *  - 邮箱授权失效：重新连邮箱（连上后再放回待发）· 晚点。
 */
import { useState } from 'react';

import type { AskMailFailed } from '../../../../shared/careerMailApply';
import { mailFailedLabels } from '../delivery/askText';
import { CompanyPoster } from '../delivery/CompanyPoster';
import type { AskView } from '../delivery/deliveryApi';
import { ConnectMailbox } from './ConnectMailbox';
import { retryMailFailed } from './mailActions';
import type { MailAct } from './MailAskCard';

/** 几家一起时铺小签，再多就看不清了（同 AskCard 的 MOSAIC_MAX）。 */
const MOSAIC_MAX = 20;

function FailedImage({ ask }: { ask: AskView }) {
  const cs = ask.companies;
  if (!cs.length) return null;
  if (cs.length > 1) return <div className="cd-mosaic">{cs.slice(0, MOSAIC_MAX).map(c => <CompanyPoster key={c.name} company={c} size="xs" state="failed" />)}</div>;
  return <CompanyPoster company={cs[0]} size="lg" state="failed" role={ask.role} />;
}

export function MailFailedCard({ ask, failed, busy, error, onAct }: {
  ask: AskView; failed: AskMailFailed; busy: boolean; error: string | null; onAct: MailAct;
}) {
  const [connecting, setConnecting] = useState(false);
  const labels = mailFailedLabels(failed);
  const retry = () => void onAct(() => retryMailFailed(ask));
  const go = () => (failed.stage === 'send' && failed.reauth ? setConnecting(true) : retry());
  return (
    <article className="cd-ask cd-ask-failed cm-ask" data-testid="ask-card-mail-failed">
      <div className="cd-ask-img"><FailedImage ask={ask} /></div>
      <div className="cd-ask-text">
        <h3 className="cd-ask-title font-human">{ask.title}</h3>
        {ask.detail && <p className="cd-ask-sub">{ask.detail}</p>}
        <div className="cd-acts">
          <button type="button" className="cd-go" disabled={busy} onClick={go}>{labels.go}</button>
          <button type="button" className="cd-later" disabled={busy} onClick={() => void onAct(async () => 'snoozed')}>{labels.later}</button>
        </div>
        {error && <p role="alert" className="cd-err">{error}</p>}
      </div>
      {connecting && <ConnectMailbox onClose={() => setConnecting(false)} onConnected={() => { setConnecting(false); retry(); }} />}
    </article>
  );
}
