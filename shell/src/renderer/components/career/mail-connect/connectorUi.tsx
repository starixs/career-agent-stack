/**
 * 邮箱连接器共用的小件：官方图标、连接状态徽标、连接状态的判定投影。
 * 状态只读服务端给的 connection（mail/connectors.ts connectionOf），界面不自己猜。
 */
import { Loader2 } from 'lucide-react';

import { Badge } from '../CareerPrimitives';
import type { MailAccount, MailConnectorId } from '../types';
import gmailIcon from './assets/gmail.svg';
import neteaseIcon from './assets/netease.png';
import qqIcon from './assets/qqmail.png';

const ICONS: Record<MailConnectorId, string> = { qq: qqIcon, '163': neteaseIcon, '126': neteaseIcon, gmail: gmailIcon };

export function ConnectorIcon({ id, size = 40 }: { id: MailConnectorId; size?: number }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-[10px] border border-[var(--line)] bg-[var(--paper)]" style={{ width: size, height: size }}>
      <img src={ICONS[id]} alt="" style={{ width: size * 0.7, height: size * 0.7 }} className="object-contain" />
    </span>
  );
}

export type ConnectorStatus = 'none' | 'active' | 'expired' | 'verifying';

/** 一家邮箱的总体状态：有失效的先提醒重新授权，其次是验证中，再是已连接。 */
export function connectorStatus(accounts: MailAccount[]): ConnectorStatus {
  if (!accounts.length) return 'none';
  if (accounts.some(a => a.connection?.state === 'expired')) return 'expired';
  if (accounts.some(a => a.connection?.state === 'verifying')) return 'verifying';
  return 'active';
}

export function StatusBadge({ status }: { status: ConnectorStatus }) {
  if (status === 'active') return <Badge tone="success">已连接</Badge>;
  if (status === 'expired') return <Badge tone="warning">需要重新授权</Badge>;
  if (status === 'verifying') return <Badge tone="info"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" />验证中</Badge>;
  return null;
}

export function HealthBadge({ account }: { account: MailAccount }) {
  const health = account.connection?.health ?? 'healthy';
  if (health === 'expired') return <Badge tone="warning">已失效</Badge>;
  if (health === 'degraded') return <Badge tone="warning">最近同步出过错</Badge>;
  return <Badge tone="success">正常</Badge>;
}

export const CAPABILITY_LABEL: Record<'receive' | 'send', string> = { receive: '收信：笔试、面试、拒信自动识别', send: '发信：经你批准后代发投递邮件' };
