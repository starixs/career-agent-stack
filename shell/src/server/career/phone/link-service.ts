/**
 * 手机连接服务（只在 Global 侧车跑一份）：绑定哪台手机、常驻原生助手盯验证码短信、配对引导。
 *
 * - 绑定记在 kv（PHONE_KV_KEY）；短信只在内存里留最近一条，不落库、不进日志。
 * - 助手（native/career-phone-helper.m）自己负责断线重连，这里只转述状态；助手进程意外退出时按退避重启。
 * - waitForCode 给以后的网申流程用：只认「开始等之后」到达、签名对得上的那条，防止批量投时串号。
 */
import type { HelperEvent, HelperProcess } from '../../utils/native-helper';

import { extractCode, parseMapTime, smsSignature } from './sms-code';
import { PHONE_KV_KEY, isLinkState, parseBinding, type CodeSms, type LinkState, type PairedPhone, type PhoneBinding, type PhoneStatus } from '../../../shared/careerPhone';

export interface PhoneLinkDeps {
  platformSupported: boolean;
  kvGet(key: string): unknown;
  kvSet(key: string, value: unknown): void;
  /** 启动助手子命令（devices / wait-pair / link <addr>）。 */
  spawn(args: string[], onEvent: (event: HelperEvent) => void, onExit: (code: number | null) => void): Promise<HelperProcess>;
  /** 打开系统蓝牙设置页：开着时手机才搜得到这台电脑。 */
  openBluetoothSettings(): Promise<void>;
  /** 状态变了通知界面刷新。 */
  changed(): void;
  /** 这台电脑在蓝牙里显示的名字（界面告诉他在手机上点哪一个）。 */
  computerName?: () => Promise<string>;
  now?: () => number;
}

/** 助手进程意外退出后的重启间隔（助手内部已有断线重连，这里只兜进程级故障）。 */
const RESPAWN_DELAY_MS = 10_000;
/** devices 子命令的等待上限。 */
const DEVICES_TIMEOUT_MS = 8_000;
/** 签名比较前去掉的修饰（「飞书招聘」与站点名「飞书」能对上）。 */
const SIGNATURE_NOISE = /招聘|校招|官方|网申|测评|平台/g;

interface Waiter { since: number; signature: string | null; resolve: (sms: CodeSms | null) => void; timer: ReturnType<typeof setTimeout> }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function signatureMatches(want: string | null, got: string | null): boolean {
  if (!want) return true;
  if (!got) return false;
  const a = want.replace(SIGNATURE_NOISE, ''); const b = got.replace(SIGNATURE_NOISE, '');
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

export class PhoneLinkService {
  private state: LinkState = 'none';
  private latest: CodeSms | null = null;
  private link: HelperProcess | null = null;
  private pairing: HelperProcess | null = null;
  private respawn: ReturnType<typeof setTimeout> | null = null;
  private waiters = new Set<Waiter>();
  private stopped = false;

  constructor(private readonly deps: PhoneLinkDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  binding(): PhoneBinding | null { return parseBinding(this.deps.kvGet(PHONE_KV_KEY)); }

  async computerName(): Promise<string> {
    try { return (await this.deps.computerName?.()) ?? ''; } catch (error) {
      console.warn('[phone-link] 读不到电脑名:', error instanceof Error ? error.message : error);
      return '';
    }
  }

  status(): PhoneStatus {
    return { platform_supported: this.deps.platformSupported, binding: this.binding(), state: this.state, pairing: !!this.pairing, latest: this.latest };
  }

  /** 侧车启动时调用：有绑定就连上。 */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.deps.platformSupported && this.binding()) await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelPairing();
    this.disconnect();
  }

  /** 已和这台电脑配对过的手机（一键选用，不用再走配对）。 */
  async pairedPhones(): Promise<PairedPhone[]> {
    if (!this.deps.platformSupported) return [];
    return new Promise((resolve) => {
      let proc: HelperProcess | null = null;
      const done = (list: PairedPhone[]) => { clearTimeout(timer); proc?.close(); resolve(list); };
      const timer = setTimeout(() => { console.warn('[phone-link] devices 超时'); done([]); }, DEVICES_TIMEOUT_MS);
      this.deps.spawn(['devices'], (ev) => {
        if (ev.ev !== 'devices' || !Array.isArray(ev.list)) return;
        done((ev.list as Array<Record<string, unknown>>).filter(d => d.phone === true)
          .map(d => ({ address: str(d.address), name: str(d.name), connected: d.connected === true })));
      }, () => done([])).then(p => { proc = p; }, (error: unknown) => { console.warn('[phone-link] devices 启动失败:', error instanceof Error ? error.message : error); done([]); });
    });
  }

  /** 引导配对：打开蓝牙设置页，等手机端发起的新配对；配上就绑定并连接。 */
  async startPairing(): Promise<void> {
    if (!this.deps.platformSupported || this.pairing) return;
    this.pairing = await this.deps.spawn(['wait-pair'], (ev) => {
      if (ev.ev !== 'paired') return;
      if (ev.phone !== true) { console.warn('[phone-link] 新配对的不是手机，继续等'); return; }
      this.pairing = null;
      void this.bind(str(ev.address), str(ev.name));
    }, () => { this.pairing = null; this.deps.changed(); });
    this.deps.changed();
    await this.deps.openBluetoothSettings().catch((error: unknown) => console.warn('[phone-link] 打不开蓝牙设置:', error instanceof Error ? error.message : error));
  }

  cancelPairing(): void {
    if (!this.pairing) return;
    this.pairing.close();
    this.pairing = null;
    this.deps.changed();
  }

  async bind(address: string, name: string): Promise<void> {
    if (!address) throw new Error('手机地址为空');
    this.cancelPairing();
    this.disconnect();
    this.latest = null;
    this.deps.kvSet(PHONE_KV_KEY, { address, name, bound_at: new Date(this.now()).toISOString() });
    await this.connect();
  }

  unbind(): void {
    this.disconnect();
    this.latest = null;
    this.state = 'none';
    this.deps.kvSet(PHONE_KV_KEY, null);
    this.deps.changed();
  }

  /** 等一条验证码短信：只认 since 之后到达、签名对得上的；超时返回 null（调用方退回请本人填）。 */
  waitForCode(opts: { since: number; signature?: string | null; timeoutMs: number }): Promise<CodeSms | null> {
    const hit = this.latest && this.accepts(this.latest, opts.since, opts.signature ?? null) ? this.latest : null;
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const waiter: Waiter = { since: opts.since, signature: opts.signature ?? null, resolve, timer: setTimeout(() => { this.waiters.delete(waiter); resolve(null); }, opts.timeoutMs) };
      this.waiters.add(waiter);
    });
  }

  private accepts(sms: CodeSms, since: number, signature: string | null): boolean {
    return !!sms.code && Date.parse(sms.seen_at) >= since && signatureMatches(signature, sms.signature);
  }

  private async connect(): Promise<void> {
    const binding = this.binding();
    if (!binding || this.stopped) return;
    this.setState('connecting');
    try {
      this.link = await this.deps.spawn(['link', binding.address], ev => this.onLinkEvent(ev), code => this.onLinkExit(code));
    } catch (error) {
      console.warn('[phone-link] 助手启动失败:', error instanceof Error ? error.message : error);
      this.setState('helper_missing');
    }
  }

  private disconnect(): void {
    if (this.respawn) { clearTimeout(this.respawn); this.respawn = null; }
    const link = this.link;
    this.link = null;
    link?.close();
  }

  private onLinkEvent(ev: HelperEvent): void {
    if (ev.ev === 'link' && isLinkState(ev.state)) { this.setState(ev.state); return; }
    if (ev.ev === 'latest') { if (typeof ev.body === 'string') this.receive(ev, false); else this.deps.changed(); return; }
    if (ev.ev === 'sms') this.receive(ev, true);
  }

  private onLinkExit(code: number | null): void {
    if (!this.link) return; // 主动断开
    this.link = null;
    // 3 = 手机没有短信读取服务、2 = 已取消配对：重启也没用
    if (code === 3 || code === 2 || this.stopped) return;
    console.warn(`[phone-link] 助手退出（code=${code}），${RESPAWN_DELAY_MS / 1000} 秒后重启`);
    this.setState('lost');
    this.respawn = setTimeout(() => { this.respawn = null; void this.connect(); }, RESPAWN_DELAY_MS);
    this.respawn.unref?.();
  }

  private receive(ev: HelperEvent, fresh: boolean): void {
    const body = str(ev.body);
    const sms: CodeSms = {
      code: extractCode(body), signature: smsSignature(body), sender: str(ev.sender),
      received_at: parseMapTime(str(ev.time)), seen_at: new Date(this.now()).toISOString(), body,
    };
    // 连上时报的「最近一条」是历史短信：只给界面看，不能拿去应付正在等的站点
    if (!fresh) sms.seen_at = sms.received_at ?? new Date(0).toISOString();
    this.latest = sms;
    console.log(`[phone-link] 收到验证码短信 signature=${sms.signature ?? '-'} fresh=${fresh}`);
    if (fresh) this.settleWaiters(sms);
    this.deps.changed();
  }

  private settleWaiters(sms: CodeSms): void {
    for (const w of [...this.waiters]) {
      if (!this.accepts(sms, w.since, w.signature)) continue;
      clearTimeout(w.timer);
      this.waiters.delete(w);
      w.resolve(sms);
    }
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    console.log(`[phone-link] state=${state}`);
    this.deps.changed();
  }
}
