/**
 * 手机连接的小件：连接状态 → 徽标与一句话（纯投影，状态只读服务端给的 PhoneStatus）、最近一条验证码。
 */
import type { CodeSms, LinkState } from '../../../../shared/careerPhone';
import { Badge, relativeTime } from '../CareerPrimitives';

type Tone = 'success' | 'warning' | 'info' | 'neutral';
interface StateView { label: string; tone: Tone; hint: string; retry: boolean }

const VIEWS: Record<LinkState, StateView | null> = {
  none: null,
  connecting: { label: '连接中', tone: 'info', hint: '正在连接已选手机，请保持手机蓝牙开启', retry: false },
  authorizing: { label: '连接短信服务', tone: 'info', hint: '请解锁手机，留意消息访问请求；小米点「是」，其他手机点「允许」', retry: false },
  connected: { label: '已连接', tone: 'success', hint: '手机短信通道已接通', retry: false },
  paused: { label: '已休眠', tone: 'neutral', hint: '连接尝试已停止，不再后台扫描；需要收码时会唤醒，也可手动重新连接', retry: true },
  lost: { label: '暂时离线', tone: 'neutral', hint: '正在尝试恢复，最多等待 2 分钟，之后停止后台连接；无需重新配对', retry: true },
  unreachable: { label: '暂时连不上', tone: 'warning', hint: '正在本轮 2 分钟内重试；请确认手机在附近且蓝牙已开启', retry: true },
  refused: { label: '短信服务未接通', tone: 'warning', hint: '请解锁手机，在「消息权限申请」中点「是」或「允许」；没有请求时可点重试', retry: true },
  unsupported: { label: '不支持', tone: 'neutral', hint: '这台手机不支持蓝牙读短信，验证码还是请你填', retry: false },
  unpaired: { label: '需要修复配对', tone: 'warning', hint: '暂未找到系统配对，设备记忆仍保留；本轮恢复尝试最多 2 分钟', retry: false },
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
