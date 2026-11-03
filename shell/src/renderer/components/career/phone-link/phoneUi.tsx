/**
 * 手机连接的小件：连接状态 → 徽标与一句话（纯投影，状态只读服务端给的 PhoneStatus）、最近一条验证码。
 */
import type { CodeSms, LinkState } from '../../../../shared/careerPhone';
import { Badge, relativeTime } from '../CareerPrimitives';

type Tone = 'success' | 'warning' | 'info' | 'neutral';
interface StateView { label: string; tone: Tone; hint: string; retry: boolean }

const VIEWS: Record<LinkState, StateView | null> = {
  none: null,
  connecting: { label: '连接中', tone: 'info', hint: '手机问能否访问短信时，点「允许」', retry: false },
  connected: { label: '已连接', tone: 'success', hint: '网申的短信验证码会自动填', retry: false },
  lost: { label: '没连上', tone: 'warning', hint: '手机在旁边、蓝牙开着就会自动连上', retry: false },
  unreachable: { label: '没连上', tone: 'warning', hint: '手机在旁边、蓝牙开着就会自动连上', retry: false },
  refused: { label: '没拿到短信权限', tone: 'warning', hint: '在手机蓝牙设置里点这台电脑，打开「短信」或「显示通知」后重试', retry: true },
  unsupported: { label: '不支持', tone: 'neutral', hint: '这台手机不支持蓝牙读短信，验证码还是请你填', retry: false },
  unpaired: { label: '配对已解除', tone: 'warning', hint: '重新连接一次就好', retry: false },
  helper_missing: { label: '缺少组件', tone: 'warning', hint: '更新到最新版后再试', retry: true },
};

export function linkStateView(state: LinkState): StateView | null {
  return VIEWS[state];
}

export function LinkBadge({ state }: { state: LinkState }) {
  const view = VIEWS[state];
  return view ? <Badge tone={view.tone}>{view.label}</Badge> : null;
}

/** 最近一条验证码：连上后的「读得到」证明，也是排查时看的那一条。 */
export function LatestCode({ sms, now }: { sms: CodeSms; now?: Date }) {
  const at = sms.received_at ?? sms.seen_at;
  return (
    <span className="flex min-w-0 items-baseline gap-2 text-xs text-[var(--muted)]">
      <span className="shrink-0">最近一条</span>
      {sms.signature && <span className="truncate">【{sms.signature}】</span>}
      {sms.code && <span className="font-mono text-sm font-semibold tracking-wider text-[var(--ink)]">{sms.code}</span>}
      {at && <span className="shrink-0 text-[var(--subtle)]">{relativeTime(at, now)}</span>}
    </span>
  );
}
