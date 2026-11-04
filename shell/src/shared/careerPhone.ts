/** 手机连接（蓝牙读短信收验证码）的状态与接口数据。界面经 /api/career/phone 读取。 */

/** 连接状态。unsupported = 手机没有短信读取服务；refused = 短信服务握手未通过（拒绝、授权未完成或握手中断，不等于用户明确拒绝）；unreachable = 连不上（不在旁边 / 蓝牙关了）。 */
export const LINK_STATES = ['none', 'connecting', 'authorizing', 'connected', 'paused', 'lost', 'unreachable', 'refused', 'unsupported', 'unpaired', 'helper_missing'] as const;
export type LinkState = typeof LINK_STATES[number];

export interface PhoneBinding {
  address: string; name: string; bound_at: string;
  /** 曾真实接通短信服务的时间，不是手机当前授权状态的替代。 */
  last_connected_at?: string;
}

/** 一条验证码短信（只在内存里，不落库、不进日志）。 */
export interface CodeSms {
  code: string | null;
  signature: string | null;
  sender: string;
  /** 手机收到的时间（ISO）；手机给的时间解析不了时为 null。 */
  received_at: string | null;
  /** 本机读到的时间（ISO）。 */
  seen_at: string;
  body: string;
}

export interface PairedPhone { address: string; name: string; connected: boolean }

export interface PhoneStatus {
  /** 目前只有 macOS 有原生助手；Windows 待做。 */
  platform_supported: boolean;
  binding: PhoneBinding | null;
  state: LinkState;
  pairing: boolean;
  latest: CodeSms | null;
}

export const PHONE_KV_KEY = 'phone_link';
export const PHONE_TABLE = 'phone_link';

// ---------- 跨边界校验：界面拿到的 /api/career/phone 数据先过这里，不直接断言类型 ----------

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStrOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const isLinkState = (v: unknown): v is LinkState => typeof v === 'string' && (LINK_STATES as readonly string[]).includes(v);

export function parseBinding(raw: unknown): PhoneBinding | null {
  const r = asRecord(raw);
  if (!asStr(r.address)) return null;
  const last = asStr(r.last_connected_at);
  return { address: asStr(r.address), name: asStr(r.name), bound_at: asStr(r.bound_at),
    ...(last && Number.isFinite(Date.parse(last)) ? { last_connected_at: last } : {}),
  };
}

function parseCodeSms(raw: unknown): CodeSms | null {
  const r = asRecord(raw);
  if (typeof r.body !== 'string') return null;
  return { code: asStrOrNull(r.code), signature: asStrOrNull(r.signature), sender: asStr(r.sender), received_at: asStrOrNull(r.received_at), seen_at: asStr(r.seen_at), body: r.body };
}

export function parsePhoneStatus(raw: unknown): PhoneStatus {
  const r = asRecord(raw);
  return {
    platform_supported: r.platform_supported === true,
    binding: parseBinding(r.binding),
    state: isLinkState(r.state) ? r.state : 'none',
    pairing: r.pairing === true,
    latest: parseCodeSms(r.latest),
  };
}

export function parsePairedPhones(raw: unknown): PairedPhone[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(asRecord).filter(p => asStr(p.address)).map(p => ({ address: asStr(p.address), name: asStr(p.name), connected: p.connected === true }));
}
