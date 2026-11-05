/**
 * 登录之旅里的验证码一格（2026-11-03 用户定：能用手机验证码登录的，他只管收验证码，其余都不用管）。
 * 号码、协议、获取验证码都已经替他办了；他把手机上收到的码填这里，替他填进网站并点登录，登上了自动下一家。
 * 点获取验证码弹了拼图：那一步网站要他本人来，在画面上拖好后码会发出来，照样填这里。
 * 走邮箱那条路弹了拼图（畅游）：只请他拖拼图，码从邮箱自己取，不给格子。
 * 弹了图形码（中国中车）：把那张图放在这里，他看图打字、回车；后面的发码、收码、登录接着自动办。
 * 看不清就点那张图，和在浏览器里点一样换一张（CAS-7）。
 *
 * 反馈（2026-11-03 用户：填完不知道生没生效、对应哪一家，「好像弄了白弄」）：每一句都带是哪一家；
 * 填上后显示「已填进 X，正在确认」，对了往下走一步说一步，错了直说，登上了说「X 已登录」。
 */
import { Check, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { apiPostJson } from '@/api/apiFetch';

import { Button } from './CareerPrimitives';
import type { LiveSnapshot } from './types';

type Sms = NonNullable<LiveSnapshot['sms']>;

const BAR = 'flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-2.5 text-sm text-[var(--ink)]';

/** 不用他动手的几步：只说进展。 */
function progressOf(sms: Sms, site: string): string | null {
  switch (sms.status) {
    case 'checking': return `已填进${site}，正在确认登录…`;
    case 'registering': return `${site}：${sms.detail ?? '正在用邮箱登录…'}`;
    case 'registered': return `${site}：${sms.detail ?? '正在确认登录…'}`;
    default: return null;
  }
}

function promptOf(sms: Sms, site: string): string {
  if (sms.status === 'image_code') return sms.detail ? `${site}：${sms.detail}` : `${site}：输入图上的字`;
  if (sms.status === 'captcha') return `${site}：先在画面上拖拼图`;
  return sms.detail ? `${site}：${sms.detail}` : `${site}：验证码已发到手机`;
}

export function SmsCodeBar({ sms }: { sms: LiveSnapshot['sms'] }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  if (!sms) return null;
  const site = sms.site ?? '这一家';
  if (sms.status === 'no_sms') {
    // 替他登不了也要说清楚：为什么、他能怎么办
    return <div data-testid="sms-code-bar" role="status" className={BAR}>{site}：{sms.detail ?? '要在画面上登录'}</div>;
  }
  if (sms.status === 'mail_captcha') {
    // 码会发到他邮箱、我们自己取：只要他拖一下拼图，不给填码的格子
    return <div data-testid="sms-code-bar" role="status" className={BAR}><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{site}：在画面上拖一下拼图</div>;
  }
  if (sms.status === 'logged_in') {
    return <div data-testid="sms-code-bar" role="status" className={BAR}><Check className="h-4 w-4 text-[var(--success)]" aria-hidden="true" />{site}已登录</div>;
  }
  const progress = progressOf(sms, site);
  if (progress) {
    return <div data-testid="sms-code-bar" role="status" className={BAR}><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{progress}</div>;
  }
  const image = sms.status === 'image_code';
  const minLength = image ? 3 : 4;
  const send = async () => {
    setBusy(true); setError(null);
    try { await apiPostJson<unknown>('/api/career/live/sms-code', { code }); setCode(''); } catch (e) {
      console.error('[career-live] 填验证码 FAILED', e);
      setError(e instanceof Error ? e.message : '没填上，再试一次');
    } finally { setBusy(false); }
  };
  const refresh = async () => {
    setRefreshing(true); setError(null);
    try { await apiPostJson<unknown>('/api/career/live/image-refresh', {}); setCode(''); } catch (e) {
      console.error('[career-live] 换图形码 FAILED', e);
      setError(e instanceof Error ? e.message : '没换成，再点一下');
    } finally { setRefreshing(false); }
  };
  return (
    <div data-testid="sms-code-bar" className={BAR}>
      <span>{promptOf(sms, site)}</span>
      {image && sms.image && (
        <button type="button" onClick={() => void refresh()} disabled={refreshing} title="看不清？点一下换一张" aria-label="换一张图形验证码" className="rounded border border-[var(--line-2)] bg-white disabled:opacity-60">
          <img src={sms.image} alt="网站给的图形验证码" className="h-9 rounded" />
        </button>
      )}
      <input aria-label={image ? '图上的字' : '短信验证码'} inputMode={image ? 'text' : 'numeric'} autoComplete={image ? 'off' : 'one-time-code'} maxLength={8} value={code}
        onChange={e => setCode(e.target.value.replace(image ? /[^A-Za-z0-9]/g : /\D/g, ''))} onKeyDown={e => { if (e.key === 'Enter' && code.length >= minLength) void send(); }}
        className="w-28 rounded-md border border-[var(--line-2)] bg-[var(--paper)] px-2 py-1 text-center font-mono text-base tracking-widest text-[var(--ink)]" />
      <Button variant="primary" busy={busy} disabled={code.length < minLength} onClick={() => void send()}>{image ? '确认' : '登录'}</Button>
      {error && <span className="w-full text-xs text-[var(--danger)]">{error}</span>}
    </div>
  );
}
