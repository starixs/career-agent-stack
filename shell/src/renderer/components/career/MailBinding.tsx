/**
 * 邮箱绑定与同步：通知中心、助力记录（新建笔试 › 从邮箱同步）、基本资料（联系方式与账号）共用。
 * 授权码只保存在本机，不进对话。
 */
import { useState } from 'react';

import { careerApi } from './careerApi';
import { Badge, Button, ErrorRow, Field, TextInput, formatDate } from './CareerPrimitives';
import type { BadgeTone } from './CareerPrimitives';
import type { MailAccount, MailPreset } from './types';
import { useCareerAction } from './useCareerData';

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

export function BindMailForm({ presets, onBound }: { presets: Record<string, MailPreset>; onBound: (message: string) => void }) {
  const [address, setAddress] = useState('');
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

