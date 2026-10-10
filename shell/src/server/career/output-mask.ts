/**
 * 输出打码（界面出口 hook）：推给渲染层的内容里，私密信息库里敏感项的明文一律换成马赛克（138****5678 / 张* / z***@x.com），
 * `{{vault:…}}` 占位符也换成 ****。渲染层按设计永远拿不到明文，所以只能在侧车出口做。
 *
 *  - 匹配规则同 Vault.redact：非 ASCII 值至少 2 字；纯 ASCII 值至少 4 字且按词边界匹配（tom 不吃掉 tomorrow）。
 *  - 流式文字会把一个值拆成两段：splitForStream 扣下"可能是某个值开头"的尾巴，等下一段到了再一起打码。
 *  - SSE 是同步出口：用异步刷新的快照（几秒过期），私密库改动后几秒内生效；侧车刚起、快照还没加载时不打码。
 */
const ASCII_RX = /^[\x20-\x7e]+$/;
const PLACEHOLDER_RX = /\{\{\s*vault:[^{}]*\}\}/g;
const PLACEHOLDER_OPEN = '{{vault:';
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一个值的马赛克：保留能认出"是哪个"的头尾，中间打星。 */
export function mosaic(value: string): string {
  const v = value.trim();
  const at = v.indexOf('@');
  if (at > 0) return `${v[0]}***${v.slice(at)}`;
  const digits = v.replace(/[\s-]/g, '');
  if (/^\+?\d{7,}$/.test(digits)) return digits.length >= 11 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : `${digits.slice(0, 2)}****${digits.slice(-2)}`;
  const chars = [...v];
  const n = chars.length;
  if (n <= 2) return `${chars[0]}*`;
  if (n === 3) return `${chars[0]}*${chars[2]}`;
  const keep = Math.max(1, Math.floor(n / 4));
  return `${chars.slice(0, keep).join('')}${'*'.repeat(Math.min(n - keep * 2, 8))}${chars.slice(n - keep).join('')}`;
}

export interface OutputMasker {
  readonly active: boolean;
  mask(text: string): string;
  maskDeep<T>(value: T): T;
  /** 流式片段：emit 是可以立刻推的（已打码），hold 是要并到下一段的尾巴（可能是某个值的开头）。 */
  splitForStream(text: string): { emit: string; hold: string };
}

export function createOutputMasker(rawValues: string[]): OutputMasker {
  const values = [...new Set(rawValues.map(v => v.trim()))]
    .filter(v => (ASCII_RX.test(v) ? v.length >= 4 : v.length >= 2))
    .sort((a, b) => b.length - a.length);
  const rules = values.map(v => ({ value: v, rx: ASCII_RX.test(v) ? new RegExp(`(?<![A-Za-z0-9])${escapeRx(v)}(?![A-Za-z0-9])`, 'g') : null, masked: mosaic(v) }));

  const mask = (text: string): string => {
    if (!text || !values.length) return text;
    let out = text.includes('{{') ? text.replace(PLACEHOLDER_RX, '****') : text;
    for (const r of rules) {
      if (!out.includes(r.value)) continue;
      out = r.rx ? out.replace(r.rx, r.masked) : out.split(r.value).join(r.masked);
    }
    return out;
  };
  const isPlain = (v: object) => { const proto = Object.getPrototypeOf(v); return proto === Object.prototype || proto === null; };
  const deep = <T,>(value: T): T => {
    if (typeof value === 'string') return mask(value) as unknown as T;
    if (Array.isArray(value)) return value.map(v => deep(v)) as unknown as T;
    // 只走纯对象：Error / Date / Buffer 等类实例原样保留（遍历会丢掉 message 之类的不可枚举字段）
    if (value && typeof value === 'object' && isPlain(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deep(v);
      return out as T;
    }
    return value;
  };
  const maskDeep = <T,>(value: T): T => (values.length ? deep(value) : value);
  const prefixes = [...values, PLACEHOLDER_OPEN];
  const splitForStream = (text: string): { emit: string; hold: string } => {
    let holdLen = 0;
    // 末尾是一个还没闭合的占位符
    const open = text.lastIndexOf('{{');
    if (open >= 0 && !text.includes('}}', open)) holdLen = text.length - open;
    // 末尾是某个值的真前缀（最长的那个）
    for (const p of prefixes) {
      for (let k = Math.min(p.length - 1, text.length); k > holdLen; k--) {
        if (text.endsWith(p.slice(0, k))) { holdLen = k; break; }
      }
    }
    return { emit: mask(text.slice(0, text.length - holdLen)), hold: text.slice(text.length - holdLen) };
  };
  return { active: values.length > 0, mask, maskDeep, splitForStream };
}

// ---------- 进程内快照 ----------
const PASSTHROUGH = createOutputMasker([]);
const TTL_MS = 3000;
let snapshot: OutputMasker = PASSTHROUGH;
let loadedAt = 0;
let loading: Promise<void> | null = null;
let disabled = false;

async function reload(): Promise<void> {
  try {
    const { getVault } = await import('./vault');
    snapshot = createOutputMasker((await getVault()).maskingValues());
  } catch (error) {
    // 不是求职工作区 / 私密库不可用：保持现状，不再反复尝试
    if (!loadedAt) disabled = true;
    console.warn('[output-mask] 私密库不可用，界面输出不打码：', error instanceof Error ? error.message : error);
  } finally {
    loadedAt = Date.now();
    loading = null;
  }
}

/** 当前打码器（同步）；过期就在后台刷新，下一次调用拿到新的。 */
export function outputMasker(): OutputMasker {
  if (!disabled && !loading && Date.now() - loadedAt > TTL_MS) loading = reload();
  return snapshot;
}

/** 私密库刚改过（保存 / 删除）时立刻刷新。 */
export function refreshOutputMask(): Promise<void> {
  disabled = false;
  loading = reload();
  return loading;
}

/** 仅测试用。 */
export function setOutputMaskerForTest(values: string[] | null): void {
  snapshot = values ? createOutputMasker(values) : PASSTHROUGH;
  loadedAt = values ? Date.now() + 1e9 : 0;
  disabled = false;
}
