/**
 * 连接一个邮箱的弹窗：说明（P1）→ 拿授权码的引导（P2）→ 填表（P3）→ 校验（P4）→ 结果（P5），以及连接管理（P6）。
 * 引导、字段、官方页面都来自服务端的连接器目录（mail/connectors.ts），这里只负责按数据渲染和在页之间走。
 * 授权码只在内存里，关窗即丢，不进任何本地存储。
 */
import { ArrowLeft, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { openExternal } from '@/utils/openExternal';

import { Button } from '../CareerPrimitives';
import type { MailAccount, MailConnector } from '../types';
import { ConnectionManage } from './ConnectionManage';
import { CAPABILITY_LABEL, ConnectorIcon } from './connectorUi';
import { CredentialStep } from './CredentialStep';
import { OauthConnect } from './OauthConnect';

export type FlowStep = 'intro' | 'guide' | 'form' | 'manage';
export interface FlowStart { connector: MailConnector; step: FlowStep; account?: MailAccount; reauthorize?: MailAccount; /** 网申用的邮箱，填表时预填 */ prefill?: string }

const BACK: Partial<Record<FlowStep, FlowStep>> = { guide: 'intro', form: 'guide' };
/** 与 className 里的 z-[70] 一致（Tailwind 只认字面量类名）。 */
const Z = 70;

export function MailConnectFlow({ start, from, onClose, onConnected }: {
  start: FlowStart;
  from?: 'chat';
  onClose: () => void;
  onConnected: (account: MailAccount) => void;
}) {
  const { connector } = start;
  const [step, setStep] = useState<FlowStep>(start.step);
  const [accountId, setAccountId] = useState<string | undefined>(start.account?.id);
  const [reauthorize, setReauthorize] = useState<MailAccount | undefined>(start.reauthorize);
  const [fromManage, setFromManage] = useState(false);
  const close = useCallback(() => onClose(), [onClose]);
  useCloseLayer(() => { close(); return true; }, Z);
  // 从管理页「重新授权」进来的，引导页的返回键回管理页；失效直接进引导的没有上一页
  const backTo: FlowStep | undefined = step === 'guide' ? (fromManage ? 'manage' : start.step === 'guide' ? undefined : 'intro') : BACK[step];

  return (
    <OverlayBackdrop onClose={close} className="z-[70] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label={`连接 ${connector.name}`} className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-lg">
        <header className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-3">
          {backTo ? (
            <button type="button" aria-label="上一步" onClick={() => setStep(backTo)} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><ArrowLeft className="h-4 w-4" /></button>
          ) : <span className="w-6" aria-hidden />}
          <ConnectorIcon id={connector.id} size={28} />
          <h2 className="flex-1 font-human text-lg font-semibold text-[var(--ink)]">{step === 'manage' ? `${connector.name} 连接管理` : `连接 ${connector.name}`}</h2>
          <button type="button" aria-label="关闭" onClick={close} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><X className="h-4 w-4" /></button>
        </header>
        <div className="overflow-y-auto px-6 py-5">
          {step === 'intro' && <ProviderIntro connector={connector} onStart={() => setStep('guide')} onOauthConnected={acc => { setAccountId(acc.id); onConnected(acc); setStep('manage'); }} />}
          {step === 'guide' && <AuthCodeGuide connector={connector} onNext={() => setStep('form')} />}
          {step === 'form' && (
            <CredentialStep
              connector={connector}
              from={from}
              reauthorize={reauthorize}
              prefill={start.prefill}
              onGoto={next => setStep(next)}
              onManage={id => { setAccountId(id); setStep('manage'); }}
              onConnected={acc => { setAccountId(acc.id); setReauthorize(undefined); onConnected(acc); }}
              onClose={close}
            />
          )}
          {step === 'manage' && accountId && (
            <ConnectionManage
              connector={connector}
              accountId={accountId}
              onReauthorize={acc => { setReauthorize(acc); setFromManage(true); setStep('guide'); }}
              onUnbound={close}
            />
          )}
        </div>
      </div>
    </OverlayBackdrop>
  );
}

/** P1：这家邮箱能做什么、授权码怎么保存、接下来三步。 */
function ProviderIntro({ connector, onStart, onOauthConnected }: { connector: MailConnector; onStart: () => void; onOauthConnected: (account: MailAccount) => void }) {
  const oauthOn = !!connector.oauth?.enabled;
  return (
    <div className="grid gap-5">
      <section>
        <h3 className="text-xs font-medium text-[var(--muted)]">连上后能做什么</h3>
        <ul className="mt-2 grid gap-1 text-sm text-[var(--ink)]">
          {connector.capabilities.map(c => <li key={c}>{CAPABILITY_LABEL[c]}</li>)}
        </ul>
      </section>
      <section className="flex gap-3 rounded-[10px] bg-[var(--inset)] px-4 py-3">
        <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
        <div className="text-sm text-[var(--ink-2)]">
          <div className="font-medium text-[var(--ink)]">授权码怎么保存</div>
          <p className="mt-1">只存在这台电脑上，不上传、不发给对话。只用来读求职相关的邮件，和在你批准后代发投递邮件。随时可以解绑，解绑后立刻删除。</p>
        </div>
      </section>
      <section>
        <h3 className="text-xs font-medium text-[var(--muted)]">接下来</h3>
        <ol className="mt-2 flex flex-wrap items-center gap-2 text-sm text-[var(--ink)]">
          {['去邮箱设置拿授权码', '填回来', '完成'].map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="h-px w-5 bg-[var(--line-2)]" />}
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--ink)] text-xs">{i + 1}</span>{s}
            </li>
          ))}
        </ol>
      </section>
      {connector.oauth && <OauthConnect connector={connector} onConnected={onOauthConnected} />}
      <Button variant={oauthOn ? 'ghost' : 'primary'} onClick={onStart} className="justify-self-start">{oauthOn ? '改用授权码连接' : '开始连接'}</Button>
    </div>
  );
}

/** P2：打开官方页面，照步骤拿授权码。步骤是服务端下发的数据。 */
function AuthCodeGuide({ connector, onNext }: { connector: MailConnector; onNext: () => void }) {
  return (
    <div className="grid gap-4">
      <ol className="grid gap-4">
        {connector.guide.map((g, i) => (
          <li key={g.title} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--ink)] text-xs font-semibold">{i + 1}</span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--ink)]">{g.title}</div>
              <p className="mt-0.5 text-sm text-[var(--ink-2)]">{g.text}</p>
              {g.path && (
                <div className="mt-2 flex flex-wrap items-center gap-1" aria-label="设置路径">
                  {g.path.map((p, j) => (
                    <span key={p} className="flex items-center gap-1">
                      {j > 0 && <span aria-hidden className="text-xs text-[var(--subtle)]">›</span>}
                      <span className="rounded-[4px] border border-[var(--line)] bg-[var(--inset)] px-2 text-xs leading-5 text-[var(--ink-2)]">{p}</span>
                    </span>
                  ))}
                </div>
              )}
              {i === 0 && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={() => void openExternal(connector.open_url)}>
                  {connector.open_label}<ExternalLink aria-hidden className="ml-1 h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="rounded-md bg-[var(--mint)] px-3 py-2 text-xs text-[var(--ink-2)]">{connector.verify_note}</p>
      {connector.help_url && (
        <button type="button" onClick={() => void openExternal(connector.help_url!)} className="justify-self-start text-xs text-[var(--primary)] underline underline-offset-2">找不到？看官方说明</button>
      )}
      <Button variant="primary" onClick={onNext} className="justify-self-start">我已获取授权码，下一步</Button>
    </div>
  );
}
