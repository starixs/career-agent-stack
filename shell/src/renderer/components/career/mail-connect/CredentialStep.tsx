/**
 * 填授权码（P3）→ 校验中（P4）→ 结果（P5）。字段由连接器目录下发；授权码只在这个组件的内存里。
 * 校验在服务端真连 IMAP / SMTP（mail/verify.ts），这里的三段文案只是让用户看得到在做什么。
 */
import { Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { copyPlainText } from '@/utils/clipboard';

import { authCodeProblem, cleanAuthCode } from '../../../../shared/mailAuthCode';

import { careerApi } from '../careerApi';
import { Button, suggestToChat } from '../CareerPrimitives';
import type { MailAccount, MailConnectErrorCode, MailConnector, MailConnectResult } from '../types';
import type { FlowStep } from './MailConnectFlow';

/** 粘贴授权码后多久清掉剪贴板（授权码等于邮箱钥匙，不留在剪贴板里）。 */
const CLIPBOARD_CLEAR_MS = 30_000;
/** 每段校验文案至少停留多久，太快用户看不清。 */
const STAGE_MS = 450;
const STAGES = ['验证授权码', '连接收信服务器', '测试收发能力'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Phase = { kind: 'form' } | { kind: 'verifying' } | { kind: 'result'; result: MailConnectResult };

export function CredentialStep({ connector, from, reauthorize, prefill, onGoto, onManage, onConnected, onClose }: {
  connector: MailConnector;
  from?: 'chat';
  reauthorize?: MailAccount;
  /** 网申用的邮箱：回音只会发到那里，默认就连它 */
  prefill?: string;
  onGoto: (step: FlowStep) => void;
  onManage: (accountId: string) => void;
  onConnected: (account: MailAccount) => void;
  onClose: () => void;
}) {
  const [email, setEmail] = useState(reauthorize?.address ?? prefill ?? '');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; code?: boolean }>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const attempt = useRef(0);
  const emailField = connector.fields.find(f => f.key === 'email');
  const codeField = connector.fields.find(f => f.key === 'authCode');
  const cleanCode = cleanAuthCode(code);
  const codeProblem = authCodeProblem(code);
  const emailError = touched.email && !EMAIL_RE.test(email.trim()) ? '邮箱地址格式不对' : null;
  const codeError = touched.code ? codeProblem : null;

  const submit = async () => {
    setTouched({ email: true, code: true });
    if (!EMAIL_RE.test(email.trim()) || codeProblem) return;
    const mine = ++attempt.current;
    setPhase({ kind: 'verifying' });
    const minWait = new Promise(r => setTimeout(r, STAGE_MS * STAGES.length));
    let result: MailConnectResult;
    try {
      result = await careerApi.verifyMailConnector(connector.id, { email: email.trim(), authCode: cleanCode, reauthorize: !!reauthorize });
    } catch (error) {
      result = { ok: false, error_code: 'unreachable', message: error instanceof Error ? error.message : String(error) };
    }
    await minWait;
    if (mine !== attempt.current) return; // 用户点了取消
    setPhase({ kind: 'result', result });
    if (result.ok) { setCode(''); onConnected(result.account); }
  };
  const cancel = () => { attempt.current++; setPhase({ kind: 'form' }); };

  if (phase.kind === 'verifying') return <VerifyPending onCancel={cancel} />;
  if (phase.kind === 'result') {
    return phase.result.ok
      ? <ConnectSuccess connector={connector} result={phase.result} from={from} onManage={onManage} onClose={onClose} />
      : <ConnectError result={phase.result} onGoto={onGoto} onRetry={() => void submit()} onForm={() => setPhase({ kind: 'form' })} onManage={onManage} />;
  }
  return (
    <form className="grid gap-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-1">
        <label htmlFor={`mail-connect-email-${connector.id}`} className="text-xs font-medium text-[var(--muted)]">{emailField?.label ?? '邮箱地址'}</label>
        <input
          id={`mail-connect-email-${connector.id}`} type="email" autoComplete="off" spellCheck={false}
          value={email} readOnly={!!reauthorize} placeholder={emailField?.placeholder}
          onChange={e => setEmail(e.target.value)} onBlur={() => setTouched(t => ({ ...t, email: true }))}
          aria-invalid={!!emailError}
          className="rounded-full border-[1.5px] border-[var(--ink)] bg-[var(--paper)] px-4 py-2 text-sm text-[var(--ink)] shadow-[3px_3px_0_var(--ink)] read-only:bg-[var(--inset)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        />
        {emailError && <span role="alert" className="text-xs text-[var(--danger)]">{emailError}</span>}
      </div>
      <SecretField label={codeField?.label ?? '授权码'} placeholder={codeField?.placeholder} helper={codeField?.helper} value={code} error={codeError}
        id={`mail-connect-code-${connector.id}`} onChange={setCode} onBlur={() => setTouched(t => ({ ...t, code: true }))} />
      <Button variant="primary" type="submit" className="justify-self-start">{reauthorize ? '重新授权' : '验证并连接'}</Button>
    </form>
  );
}

/** 授权码输入框：默认掩码可切换明文；粘贴后 30 秒清掉剪贴板（剪贴板里还是这串码才清）。 */
function SecretField({ id, label, placeholder, helper, value, error, onChange, onBlur }: {
  id: string; label: string; placeholder?: string; helper?: string; value: string; error: string | null;
  onChange: (v: string) => void; onBlur: () => void;
}) {
  const [shown, setShown] = useState(false);
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').trim();
    if (!pasted) return;
    setTimeout(() => { void clearClipboardIfStill(pasted); }, CLIPBOARD_CLEAR_MS);
  };
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs font-medium text-[var(--muted)]">{label}</label>
      <span className="relative">
        <input
          id={id} type={shown ? 'text' : 'password'} autoComplete="new-password" spellCheck={false}
          value={value} placeholder={placeholder} aria-invalid={!!error}
          onChange={e => onChange(e.target.value)} onBlur={onBlur} onPaste={onPaste}
          className="w-full rounded-full border-[1.5px] border-[var(--ink)] bg-[var(--paper)] py-2 pl-4 pr-10 font-mono text-sm tracking-wider text-[var(--ink)] shadow-[3px_3px_0_var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        />
        <button type="button" aria-label={shown ? '隐藏授权码' : '显示授权码'} onClick={() => setShown(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--ink)]">
          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </span>
      {error ? <span role="alert" className="text-xs text-[var(--danger)]">{error}</span> : helper && <span className="text-xs text-[var(--subtle)]">{helper}</span>}
    </div>
  );
}

async function clearClipboardIfStill(code: string): Promise<void> {
  try {
    if ((await navigator.clipboard.readText()).trim() === code) await copyPlainText('');
  } catch (error) {
    console.warn('[career-mail] 没能清空剪贴板（系统不允许读剪贴板）:', error instanceof Error ? error.message : error);
  }
}

/** P4：三段文案轮换。 */
function VerifyPending({ onCancel }: { onCancel: () => void }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setI(n => Math.min(n + 1, STAGES.length - 1)), STAGE_MS);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="grid justify-items-start gap-4" role="status" aria-live="polite">
      <ol className="grid gap-2 text-sm">
        {STAGES.map((s, n) => (
          <li key={s} className={`flex items-center gap-2 ${n <= i ? 'text-[var(--ink)]' : 'text-[var(--subtle)]'}`}>
            {n < i ? <Check className="h-4 w-4 text-[var(--success)]" /> : n === i ? <Loader2 className="h-4 w-4 animate-spin" /> : <span className="h-4 w-4" />}
            {s}
          </li>
        ))}
      </ol>
      <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
    </div>
  );
}

function ConnectSuccess({ connector, result, from, onManage, onClose }: {
  connector: MailConnector; result: Extract<MailConnectResult, { ok: true }>; from?: 'chat'; onManage: (accountId: string) => void; onClose: () => void;
}) {
  return (
    <div className="grid justify-items-start gap-3" role="status">
      <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--success)] text-white"><Check className="h-5 w-5" /></span>
      <div className="font-human text-lg font-semibold text-[var(--ink)]">{connector.name}已连接</div>
      <p className="text-sm text-[var(--ink-2)]">{result.account.address} 近半年的求职邮件正在后台收进来，收好后出现在通知中心。可以关掉这里去做别的。</p>
      {!result.smtp_ok && <p className="text-xs text-[var(--warning)]">发信验证没通过，暂时不能代发邮件；收信不受影响。</p>}
      {result.apply_address_mismatch && <p className="text-xs text-[var(--warning)]">网申填的是 {result.apply_address_mismatch}，招聘方的回音会发到那里，这个邮箱收不到。</p>}
      <div className="flex flex-wrap gap-2">
        {from === 'chat'
          ? <Button variant="primary" onClick={onClose}>回到对话</Button>
          : <Button variant="primary" onClick={() => { suggestToChat('邮箱连好了，帮我看看最近有哪些求职邮件要我处理'); onClose(); }}>去对话使用</Button>}
        <Button variant="secondary" onClick={() => onManage(result.account.id)}>管理连接</Button>
      </div>
    </div>
  );
}

const ERROR_TITLE: Record<MailConnectErrorCode, string> = {
  imap_auth_failed: '授权码不正确或已失效', imap_disabled: '还没开启 IMAP 服务', provider_blocked: '邮箱拦下了这次登录',
  unreachable: '网络异常', duplicate: '这个邮箱已经连上了', invalid_input: '填的内容格式不对',
};

/** P5b：按原因给出路。 */
function ConnectError({ result, onGoto, onRetry, onForm, onManage }: {
  result: Extract<MailConnectResult, { ok: false }>; onGoto: (s: FlowStep) => void; onRetry: () => void; onForm: () => void; onManage: (accountId: string) => void;
}) {
  const code = result.error_code;
  return (
    <div className="grid justify-items-start gap-3" role="alert">
      <div className="font-human text-lg font-semibold text-[var(--ink)]">{ERROR_TITLE[code]}</div>
      <p className="text-sm text-[var(--ink-2)]">{result.message}</p>
      <div className="flex flex-wrap gap-2">
        {(code === 'imap_auth_failed' || code === 'invalid_input') && <Button variant="primary" onClick={onForm}>重新填写</Button>}
        {(code === 'imap_auth_failed' || code === 'imap_disabled' || code === 'provider_blocked') && <Button variant={code === 'imap_disabled' ? 'primary' : 'secondary'} onClick={() => onGoto('guide')}>{code === 'imap_disabled' ? '打开设置教程' : '查看教程'}</Button>}
        {(code === 'unreachable' || code === 'provider_blocked') && <Button variant="primary" onClick={onRetry}>重试</Button>}
        {code === 'duplicate' && result.account_id && <Button variant="primary" onClick={() => onManage(result.account_id!)}>查看连接</Button>}
      </div>
    </div>
  );
}
