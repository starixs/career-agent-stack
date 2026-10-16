/**
 * 邮箱绑定与同步：通知中心、助力记录（新建笔试 › 从邮箱同步）、基本资料（联系方式与账号）、对话里的绑定卡片共用。
 *
 * 绑定先选邮箱：QQ / 163 / 126 / Gmail 走一键连接——弹窗里直接显示官方登录页，扫码登录、按官方提示验证后，
 * 授权码自动读取、验证、绑定（服务端 mail/connect.ts）；Outlook 和其他邮箱手动填。授权码只保存在本机，不进对话。
 */
import { Check, Mail, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import { careerApi } from './careerApi';
import { CareerLiveViewport } from './CareerLiveViewport';
import { Badge, Button, ErrorRow, Field, TextInput, formatDate } from './CareerPrimitives';
import type { BadgeTone } from './CareerPrimitives';
import type { LiveFrame, LiveStreamEvent, MailAccount, MailConnectSession, MailPreset } from './types';
import { useCareerAction } from './useCareerData';
import { useLiveStream } from './useGlobalLive';

export const ACCOUNT_STATUS: Record<MailAccount['status'], { label: string; tone: BadgeTone }> = {
  ok: { label: '已连接', tone: 'success' }, unverified: { label: '待验证', tone: 'warning' }, auth_failed: { label: '授权失败', tone: 'error' }, error: { label: '出错', tone: 'error' },
};

/** 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前；解析失败退回日期。 */
export function relativeTime(value: string | null | undefined, now: Date = new Date()): string {
  if (!value) return '从未';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return formatDate(value);
  const diffMin = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  return `${Math.round(diffHour / 24)} 天前`;
}

/** 按邮箱域名猜 provider；猜不到就走通用 IMAP 并让用户补 host。 */
export function detectProvider(address: string): MailAccount['provider'] {
  const domain = address.split('@')[1]?.trim().toLowerCase() ?? '';
  if (!domain) return 'imap';
  if (domain === 'qq.com' || domain === 'foxmail.com') return 'qq';
  if (domain === '163.com') return '163';
  if (domain === '126.com') return '126';
  if (domain.includes('gmail') || domain === 'googlemail.com') return 'gmail';
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live.')) return 'outlook';
  return 'imap';
}

export function MailAccountRow({ account, preset, onChanged }: { account: MailAccount; preset?: MailPreset; onChanged: () => void }) {
  const act = useCareerAction();
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  const status = ACCOUNT_STATUS[account.status] ?? { label: account.status, tone: 'neutral' as BadgeTone };
  const sync = () => act.run(async () => {
    const results = await careerApi.syncMail(account.id);
    const mine = results.find(r => r.account_id === account.id) ?? results[0];
    setSyncSummary(mine ? (mine.error ? `同步失败：${mine.error}` : `拉到 ${mine.fetched} 封，其中 ${mine.job_related} 封与求职相关`) : '同步完成');
    onChanged();
  });
  const unbind = () => act.run(async () => {
    if (!window.confirm(`解绑 ${account.address}？已同步的邮件会保留，之后不再自动拉取。`)) return;
    await careerApi.deleteMailAccount(account.id);
    onChanged();
  });
  return (
    <li className="py-2">
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium text-[var(--ink)]">{account.address}</span>
        <span className="text-xs text-[var(--muted)]">{preset?.label ?? account.provider}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-xs text-[var(--muted)]">上次同步：{relativeTime(account.last_sync_at)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void sync()}>立即同步</Button>
          <Button variant="ghost" size="sm" busy={act.busy} onClick={() => void unbind()}>解绑</Button>
        </div>
      </div>
      {account.last_error && <div className="mt-1 text-xs text-[var(--danger)]">{account.last_error}</div>}
      {syncSummary && <div role="status" className="mt-1 text-xs text-[var(--muted)]">{syncSummary}</div>}
      {act.error && <ErrorRow message={act.error} />}
    </li>
  );
}

/** 手动填授权码（Outlook、企业邮箱，或一键连接走不通时）。 */
export function ManualMailForm({ presets, onBound, initialAddress = '' }: { presets: Record<string, MailPreset>; onBound: (message: string) => void; initialAddress?: string }) {
  const [address, setAddress] = useState(initialAddress);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const act = useCareerAction();
  const provider = detectProvider(address);
  const preset = presets[provider];

  const submit = () => act.run(async () => {
    const addr = address.trim();
    if (!addr.includes('@')) throw new Error('请输入完整的邮箱地址');
    if (!password.trim()) throw new Error('请输入授权码 / 应用密码');
    if (provider === 'imap' && (!imapHost.trim() || !smtpHost.trim())) throw new Error('这个邮箱不在预设里，请填写 IMAP 与 SMTP 服务器');
    const r = await careerApi.bindMailAccount({
      address: addr, password: password.trim(), display_name: displayName.trim() || undefined,
      ...(provider === 'imap' ? { imap_host: imapHost.trim(), smtp_host: smtpHost.trim() } : {}),
    });
    setPassword('');
    if (r.verify?.error) {
      setVerifyError(`连接失败：${r.verify.error}。账号已保存，修正授权码后可重新绑定。`);
      return;
    }
    setVerifyError(null);
    onBound(`已连接，拉到 ${r.verify?.fetched ?? 0} 封，其中 ${r.verify?.job_related ?? 0} 封与求职相关`);
  });

  return (
    <div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="邮箱地址">
          <TextInput aria-label="邮箱地址" placeholder="you@qq.com" value={address} onChange={e => setAddress(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="授权码 / 应用密码" hint="不是登录密码；只保存在本机，不会发给对话或任何第三方。">
          <TextInput aria-label="授权码" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="显示名（可选）">
          <TextInput aria-label="显示名" placeholder="投递邮件署名" value={displayName} onChange={e => setDisplayName(e.target.value)} />
        </Field>
      </div>
      {address.includes('@') && (
        <div className="text-xs text-[var(--muted)]">
          识别为 <Badge tone="info">{preset?.label ?? (provider === 'imap' ? '通用 IMAP' : provider)}</Badge>
          {preset?.help && <span className="ml-1">{preset.help}</span>}
        </div>
      )}
      {provider === 'imap' && address.includes('@') && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Field label="IMAP 服务器"><TextInput aria-label="IMAP 服务器" placeholder="imap.example.com" value={imapHost} onChange={e => setImapHost(e.target.value)} /></Field>
          <Field label="SMTP 服务器"><TextInput aria-label="SMTP 服务器" placeholder="smtp.example.com" value={smtpHost} onChange={e => setSmtpHost(e.target.value)} /></Field>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" busy={act.busy} onClick={() => void submit()}>绑定并验证</Button>
        {verifyError && <span role="status" className="text-xs text-[var(--danger)]">{verifyError}</span>}
      </div>
      {act.error && <ErrorRow message={act.error} />}
    </div>
  );
}


type MailChoice = MailAccount['provider'];

export interface MailOption { provider: MailChoice; label: string; connect: boolean; note: string; placeholder: string }

export const MAIL_OPTIONS: MailOption[] = [
  { provider: 'qq', label: 'QQ 邮箱', connect: true, note: '扫码登录，授权码自动读取', placeholder: 'you@qq.com' },
  { provider: '163', label: '163 邮箱', connect: true, note: '扫码登录，授权码自动读取', placeholder: 'you@163.com' },
  { provider: '126', label: '126 邮箱', connect: true, note: '扫码登录，授权码自动读取', placeholder: 'you@126.com' },
  { provider: 'gmail', label: 'Gmail', connect: true, note: '登录后创建应用专用密码，自动读取', placeholder: 'you@gmail.com' },
  { provider: 'outlook', label: 'Outlook', connect: false, note: '微软已不支持授权码登录，先手动试试', placeholder: 'you@outlook.com' },
  { provider: 'imap', label: '其他邮箱', connect: false, note: '学校 / 企业邮箱，手动填服务器', placeholder: 'you@school.edu.cn' },
];

const TILE: Record<MailChoice, { bg: string; fg: string; mark: string }> = {
  qq: { bg: 'linear-gradient(135deg,#F9D423,#F37335)', fg: '#fff', mark: '' },
  '163': { bg: '#D9261C', fg: '#fff', mark: '163' },
  '126': { bg: '#1E8E4E', fg: '#fff', mark: '126' },
  gmail: { bg: '#fff', fg: '#EA4335', mark: '' },
  outlook: { bg: '#0F6CBD', fg: '#fff', mark: 'O' },
  imap: { bg: 'var(--inset)', fg: 'var(--ink-2)', mark: '' },
};

/** 邮箱图标：品牌色方块 + 信封或数字（不用各家官方标志）。 */
export function MailProviderIcon({ provider, size = 40 }: { provider: MailChoice; size?: number }) {
  const t = TILE[provider] ?? TILE.imap;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[22%] border border-[var(--line)] font-semibold"
      style={{ width: size, height: size, background: t.bg, color: t.fg, fontSize: size * 0.32 }}
    >
      {t.mark || <Mail style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />}
    </span>
  );
}

/**
 * 绑定邮箱：先选邮箱。能一键连接的打开连接弹窗，其余展开手动表单。
 * 名字沿用 BindMailForm：通知中心、助力记录、基本资料三处直接换成这一套。
 */
export function BindMailForm({ presets, onBound }: { presets: Record<string, MailPreset>; onBound: (message: string) => void }) {
  const [connecting, setConnecting] = useState<MailOption | null>(null);
  const [manual, setManual] = useState<MailOption | null>(null);
  return (
    <div className="mt-3 space-y-3 border-t border-[var(--line)] pt-3">
      <MailOptionGrid
        selected={manual?.provider ?? null}
        onPick={option => { if (option.connect) { setManual(null); setConnecting(option); } else setManual(option); }}
      />
      {manual && <ManualMailForm key={manual.provider} presets={presets} onBound={onBound} />}
      {!manual && (
        <button type="button" onClick={() => setManual(MAIL_OPTIONS[MAIL_OPTIONS.length - 1])} className="text-xs text-[var(--muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline">
          已经有授权码？手动填写
        </button>
      )}
      {connecting && (
        <MailConnectDialog
          option={connecting}
          onClose={() => setConnecting(null)}
          onManual={() => { setManual(connecting); setConnecting(null); }}
          onBound={message => { setConnecting(null); onBound(message); }}
        />
      )}
    </div>
  );
}

export function MailOptionGrid({ selected, onPick, options = MAIL_OPTIONS }: { selected: MailChoice | null; onPick: (option: MailOption) => void; options?: MailOption[] }) {
  return (
    <ul aria-label="选择邮箱" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {options.map(option => (
        <li key={option.provider}>
          <button
            type="button"
            onClick={() => onPick(option)}
            className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${selected === option.provider ? 'border-[var(--primary)] bg-[var(--primary-soft)]' : 'border-[var(--line)]'}`}
          >
            <MailProviderIcon provider={option.provider} size={32} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-[var(--ink)]">{option.label}</span>
              <span className="block truncate text-xs text-[var(--muted)]">{option.note}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const RUNNING: ReadonlySet<MailConnectSession['status']> = new Set(['starting', 'login', 'settings', 'need_address', 'verifying']);
const STEPS: Array<{ label: string; reached: (s: MailConnectSession['status']) => boolean }> = [
  { label: '登录', reached: s => s !== 'starting' },
  { label: '生成授权码', reached: s => s === 'settings' || s === 'need_address' || s === 'verifying' || s === 'done' },
  { label: '验证并绑定', reached: s => s === 'verifying' || s === 'done' },
];

/** 连接弹窗：点「连接」后在产品浏览器打开官方页面，画面直接显示在弹窗里，扫码 / 点按钮都在这里完成。 */
export function MailConnectDialog({ option, onClose, onManual, onBound, pollMs = 1500 }: {
  option: MailOption;
  onClose: () => void;
  onManual: () => void;
  onBound: (message: string) => void;
  pollMs?: number;
}) {
  const [session, setSession] = useState<MailConnectSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [address, setAddress] = useState('');
  const sessionRef = useRef<MailConnectSession | null>(null);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const running = !!session && RUNNING.has(session.status);

  const close = useCallback(() => {
    const s = sessionRef.current;
    if (s && RUNNING.has(s.status)) void careerApi.cancelMailConnect(s.id).catch(() => undefined);
    onClose();
  }, [onClose]);
  useCloseLayer(() => { close(); return true; }, 70);

  useEffect(() => {
    if (!session || !RUNNING.has(session.status)) return;
    const timer = setTimeout(() => {
      careerApi.mailConnect(session.id).then(setSession).catch(e => setError(e instanceof Error ? e.message : String(e)));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [session, pollMs]);

  const start = async () => {
    setStarting(true); setError(null);
    try { setSession(await careerApi.startMailConnect(option.provider as MailConnectSession['provider'])); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setStarting(false);
  };
  const submitAddress = async () => {
    if (!session || !address.includes('@')) return;
    try { setSession(await careerApi.mailConnectAddress(session.id, address.trim())); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const done = session?.status === 'done';
  const failed = session?.status === 'failed';
  return (
    <OverlayBackdrop onClose={close} className="z-[70] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label={`连接 ${option.label}`} className="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--paper)] shadow-lg">
        <div className="flex justify-end px-4 pt-3">
          <button type="button" aria-label="关闭" onClick={close} className="rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-col items-center px-8 pb-6 text-center">
          <MailProviderIcon provider={option.provider} size={64} />
          <h2 className="mt-4 font-human text-xl font-semibold text-[var(--ink)]">连接 {option.label}</h2>
          {!session && (
            <>
              <p className="mt-2 max-w-md text-sm text-[var(--muted)]">笔试、面试、拒信邮件会自动识别进来，不用天天刷邮箱。点连接后在这里扫码登录，授权码自动读取，不用复制粘贴；只保存在本机，小芽看不到。</p>
              <Button variant="primary" busy={starting} onClick={() => void start()} className="mt-5 min-w-28">连接</Button>
            </>
          )}
          {session && (
            <>
              <ol aria-label="连接进度" className="mt-3 flex items-center gap-2 text-xs">
                {STEPS.map((step, i) => {
                  const reached = step.reached(session.status);
                  return (
                    <li key={step.label} className="flex items-center gap-2">
                      {i > 0 && <span aria-hidden className="h-px w-6 bg-[var(--line)]" />}
                      <span className={reached ? 'font-medium text-[var(--ink)]' : 'text-[var(--subtle)]'}>{step.label}</span>
                    </li>
                  );
                })}
              </ol>
              <p role="status" className={`mt-3 max-w-md text-sm ${failed ? 'text-[var(--danger)]' : done ? 'text-[var(--success)]' : 'text-[var(--ink)]'}`}>
                {done && <Check className="mr-1 inline h-4 w-4" />}
                {failed ? (session.error ?? session.hint) : session.hint}
              </p>
              {done && session.summary && <p className="mt-1 text-xs text-[var(--muted)]">{session.summary}</p>}
              {!failed && !done && session.error && <p className="mt-1 max-w-md text-xs text-[var(--danger)]">{session.error}</p>}
            </>
          )}
        </div>
        {running && <ConnectViewport />}
        {session?.status === 'need_address' && (
          <div className="flex items-end gap-2 px-6 pb-4">
            <Field label="邮箱地址">
              <TextInput aria-label="邮箱地址" placeholder={option.placeholder} value={address} onChange={e => setAddress(e.target.value)} autoComplete="off" />
            </Field>
            <Button variant="primary" disabled={!address.includes('@')} onClick={() => void submitAddress()}>继续</Button>
          </div>
        )}
        {error && <div className="px-6 pb-3"><ErrorRow message={error} /></div>}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] px-6 py-3">
          <button type="button" onClick={() => { close(); onManual(); }} className="text-xs text-[var(--muted)] underline-offset-2 hover:text-[var(--ink)] hover:underline">改用手动填写授权码</button>
          {done && <Button variant="primary" onClick={() => onBound(`已连接 ${session.address ?? ''}，${session.summary ?? '开始同步'}`)}>完成</Button>}
          {(failed || session?.status === 'cancelled') && <Button variant="secondary" busy={starting} onClick={() => void start()}>重新连接</Button>}
        </div>
      </div>
    </OverlayBackdrop>
  );
}

/** 弹窗里的实时画面：连接期间控制权在用户这边，可以直接点、直接输入。 */
function ConnectViewport() {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const onEvent = useCallback((ev: LiveStreamEvent) => { if (ev.type === 'frame') setFrame(ev as LiveFrame); }, []);
  useLiveStream(true, onEvent);
  return (
    <div className="mx-6 mb-4 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--inset)]">
      <CareerLiveViewport frame={frame} interactive placeholder="正在打开官方页面…" className="max-h-[420px]" />
    </div>
  );
}
