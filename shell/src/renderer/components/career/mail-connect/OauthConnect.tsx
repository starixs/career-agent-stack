/**
 * OAuth 轨（预留）：连接器标了 oauth 时，说明页显示这一块。
 * 审核通过、云端开启前（enabled=false）只说明现状，流程照常走授权码；开启后在用户浏览器打开官方授权页，轮询结果。
 */
import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { openExternal } from '@/utils/openExternal';

import { careerApi } from '../careerApi';
import { Button, ErrorRow } from '../CareerPrimitives';
import type { MailAccount, MailConnector } from '../types';

/** 查授权结果的间隔。 */
const POLL_MS = 2_000;

export function OauthConnect({ connector, onConnected }: { connector: MailConnector; onConnected: (account: MailAccount) => void }) {
  const [state, setState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (!state) return;
    const timer = setInterval(() => {
      careerApi.mailOauthStatus(connector.id, state).then(r => {
        if (done.current) return;
        if (r.status === 'done' && r.account) { done.current = true; setState(null); onConnected(r.account); }
        if (r.status === 'failed') { setState(null); setError('授权没完成，可以再试一次'); }
      }).catch(e => setError(e instanceof Error ? e.message : String(e)));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [state, connector.id, onConnected]);

  if (!connector.oauth?.enabled) {
    return <p className="text-xs text-[var(--subtle)]">{connector.name} 官方一键授权审核通过后开放，现在先用应用专用密码连接。</p>;
  }
  const start = async () => {
    setStarting(true); setError(null);
    try {
      const r = await careerApi.startMailOauth(connector.id);
      if (!r.ok) { setError(r.message); return; }
      setState(r.state);
      await openExternal(r.authorize_url);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setStarting(false); }
  };
  return (
    <div className="grid justify-items-start gap-2">
      <Button variant="primary" busy={starting} onClick={() => void start()}>用 {connector.name} 账号授权<ExternalLink aria-hidden className="ml-1 h-3.5 w-3.5" /></Button>
      {state && <p role="status" className="flex items-center gap-2 text-xs text-[var(--muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />在浏览器里完成授权后，这里会自动连上</p>}
      {error && <ErrorRow message={error} />}
    </div>
  );
}
