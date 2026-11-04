/**
 * 手机连接服务（只在 Global 侧车跑一份）：绑定哪台手机、常驻原生助手盯验证码短信、配对引导。
 *
 * - 绑定记在 kv（PHONE_KV_KEY）；短信只在内存里留最近一条，不落库、不进日志。
 * - 助手执行传输重试，Global 统一限制一轮离线恢复预算；到期停助手休眠，显式需求才唤醒。
 * - 预算内保留最近失败；成功不清设备记忆，后台状态刷新不延长预算。
 * - waitForCode 给以后的网申流程用：只认「开始等之后」到达、签名对得上的那条，防止批量投时串号。
 */
import { createHash } from 'node:crypto';
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
/** 配对被系统移除后仍记住设备，低频检查它是否已重新配对。 */
const REPAIR_CHECK_MS = 30_000;
/** 一轮离线恢复的总预算（包含原生内部重试与进程重启），到期停进程而非降低扫描频率。 */
const RECONNECT_WINDOW_MS = 2 * 60_000;
/** EOF / SIGTERM 无响应时兜住原生 SDK 卡死，避免休眠后仍留后台进程。 */
const LINK_CLOSE_GRACE_MS = 5_000;
/** devices 子命令的等待上限。 */
const DEVICES_TIMEOUT_MS = 8_000;
/** 签名比较前去掉的修饰（「飞书招聘」与站点名「飞书」能对上）。 */
const SIGNATURE_NOISE = /招聘|校招|官方|网申|测评|平台/g;

export interface CodeWaitOptions { since: number; signature?: string | null; timeoutMs: number; signal?: AbortSignal; /** 自动网申：精确签名、手机接收时间与一次消费。 */ strict?: boolean }
interface Waiter { opts: CodeWaitOptions; resolve: (sms: CodeSms | null) => void }
/** MAP 时间只有秒精度。 */
const MAP_CLOCK_PRECISION_MS = 1000;
/** 只保留短期去重摘要，不保留额外的短信正文。 */
const CONSUMED_TTL_MS = 10 * 60_000;

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
  private linkGeneration = 0;
  private connecting = false;
  private pairing: HelperProcess | null = null;
  private pairingStarting = false;
  private pairingGeneration = 0;
  private respawn: ReturnType<typeof setTimeout> | null = null;
  private retryWindow: ReturnType<typeof setTimeout> | null = null;
  private connectionWaiters = new Set<(connected: boolean) => void>();
  private waiters = new Set<Waiter>();
  private stopped = false;
  private consumed = new Map<string, number>();
  private latestFresh = false;

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
    return { platform_supported: this.deps.platformSupported, binding: this.binding(), state: this.state, pairing: !!this.pairing || this.pairingStarting, latest: this.latest };
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
    if (!this.deps.platformSupported || this.pairing || this.pairingStarting) return;
    // Repair the remembered target; don't lose it or wait for a "new" address.
    if (this.binding()) { await this.reconnect(); await this.deps.openBluetoothSettings(); return; }
    const generation = ++this.pairingGeneration;
    this.pairingStarting = true; this.deps.changed();
    let finished = false;
    try {
      const proc = await this.deps.spawn(['wait-pair'], ev => {
        if (generation !== this.pairingGeneration || ev.ev !== 'paired') return;
        if (ev.phone !== true) { console.warn('[phone-link] 新配对的不是手机，继续等'); return; }
        finished = true;
        void this.bind(str(ev.address), str(ev.name)).catch(error => console.warn('[phone-link] 配对后连接失败:', error));
      }, () => {
        if (generation !== this.pairingGeneration) return;
        finished = true; this.pairing = null; this.pairingStarting = false; this.deps.changed();
      });
      if (generation !== this.pairingGeneration || finished) { proc.close(); return; }
      this.pairing = proc;
      await this.deps.openBluetoothSettings();
    } finally {
      if (generation === this.pairingGeneration) { this.pairingStarting = false; this.deps.changed(); }
    }
  }

  cancelPairing(): void {
    this.pairingGeneration++;
    const active = this.pairing || this.pairingStarting;
    this.pairing?.close(); this.pairing = null; this.pairingStarting = false;
    if (active) this.deps.changed();
  }

  async bind(address: string, name: string): Promise<void> {
    if (!address) throw new Error('手机地址为空');
    if (this.binding()?.address === address) { await this.reconnect(); return; }
    this.cancelPairing();
    this.disconnect();
    this.latest = null;
    this.deps.kvSet(PHONE_KV_KEY, { address, name, bound_at: new Date(this.now()).toISOString() });
    this.setState('connecting');
    await this.connect();
  }

  /** 重连不改持久记忆，也不打开首次配对流程。 */
  async reconnect(): Promise<void> {
    if (!this.binding()) throw new Error('尚未选择手机');
    this.cancelPairing(); this.disconnect();
    this.setState('connecting');
    await this.connect();
  }

  /** 仅真实收码任务可自动唤醒；状态读取/页面刷新不唤醒，不延长正在进行的一轮。 */
  async ensureConnected(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (this.stopped || !this.deps.platformSupported || !this.binding()) return false;
    const waking = ['paused', 'none'].includes(this.state) ? this.reconnect() : Promise.resolve();
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => { this.connectionWaiters.delete(done); signal.removeEventListener('abort', abort); };
      const done = (connected: boolean) => { cleanup(); resolve(connected); };
      const abort = () => done(false);
      this.connectionWaiters.add(done);
      signal.addEventListener('abort', abort, { once: true });
      void waking.catch((error: unknown) => { cleanup(); reject(error); });
      if (signal.aborted) done(false);
      else if (this.state === 'connected') done(true);
      else if (['none', 'paused', 'unsupported', 'helper_missing'].includes(this.state)) done(false);
    });
  }

  unbind(): void {
    this.cancelPairing(); this.disconnect();
    this.latest = null;
    this.state = 'none';
    this.deps.kvSet(PHONE_KV_KEY, null);
    this.deps.changed();
  }

  /** 等一条验证码短信：只认 since 之后到达、签名对得上的；超时返回 null（调用方退回请本人填）。 */
  waitForCode(opts: CodeWaitOptions): Promise<CodeSms | null> {
    if (opts.signal?.aborted) return Promise.resolve(null);
    const hit = this.latest && (!opts.strict || this.latestFresh) && this.accepts(this.latest, opts) ? this.latest : null;
    if (hit) { this.consume(hit, opts); return Promise.resolve(hit); }
    return new Promise((resolve) => {
      const done = (sms: CodeSms | null) => {
        clearTimeout(timer); opts.signal?.removeEventListener('abort', abort);
        this.waiters.delete(waiter); resolve(sms);
      };
      const abort = () => done(null);
      const waiter: Waiter = { opts, resolve: done };
      const timer = setTimeout(abort, opts.timeoutMs);
      this.waiters.add(waiter);
      opts.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private smsKey(sms: CodeSms): string { return createHash('sha256').update(`${sms.sender}|${sms.received_at}|${sms.body}`).digest('hex'); }

  private consume(sms: CodeSms, opts: CodeWaitOptions): void {
    for (const [key, at] of this.consumed) if (at < this.now() - CONSUMED_TTL_MS) this.consumed.delete(key);
    if (opts.strict) this.consumed.set(this.smsKey(sms), this.now());
  }

  private accepts(sms: CodeSms, opts: CodeWaitOptions): boolean {
    if (!sms.code || Date.parse(sms.seen_at) < opts.since) return false;
    if (!opts.strict) return signatureMatches(opts.signature ?? null, sms.signature);
    return !!opts.signature && opts.signature === sms.signature && !!sms.received_at
      && Date.parse(sms.received_at) >= opts.since - MAP_CLOCK_PRECISION_MS
      && Date.parse(sms.received_at) <= this.now() + MAP_CLOCK_PRECISION_MS
      && !this.consumed.has(this.smsKey(sms));
  }

  private async connect(): Promise<void> {
    const binding = this.binding();
    if (!binding || this.stopped || this.state === 'paused' || this.link || this.connecting) return;
    this.beginRetryWindow();
    if (this.respawn) { clearTimeout(this.respawn); this.respawn = null; }
    this.connecting = true;
    // Background checks must not replace an actionable failure with a spinner.
    if (!['unpaired', 'lost', 'unreachable', 'refused'].includes(this.state)) this.setState('connecting');
    const generation = ++this.linkGeneration;
    let exited = false;
    try {
      const proc = await this.deps.spawn(['link', binding.address],
        ev => { if (generation === this.linkGeneration) this.onLinkEvent(ev); },
        code => { exited = true; if (generation === this.linkGeneration) this.onLinkExit(code); });
      if (generation !== this.linkGeneration || this.stopped || exited) { this.closeLinkProcess(proc); return; }
      this.link = proc;
    } catch (error) {
      console.warn('[phone-link] 助手启动失败:', error instanceof Error ? error.message : error);
      if (generation === this.linkGeneration) this.setState('helper_missing');
    } finally { if (generation === this.linkGeneration) this.connecting = false; }
  }

  private beginRetryWindow(): void {
    if (this.retryWindow) return;
    this.retryWindow = setTimeout(() => {
      console.log('[phone-link] retry budget exhausted; pausing until explicit demand');
      this.disconnect(); this.latest = null; this.latestFresh = false;
      this.setState('paused');
    }, RECONNECT_WINDOW_MS);
    this.retryWindow.unref?.();
  }

  private clearRetryWindow(): void {
    if (this.retryWindow) clearTimeout(this.retryWindow);
    this.retryWindow = null;
  }

  private closeLinkProcess(proc: HelperProcess): void {
    proc.close();
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;
    const force = setTimeout(() => {
      proc.child.removeListener('exit', exited);
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        console.warn('[phone-link] helper did not stop; terminating owned process');
        proc.child.kill('SIGKILL');
      }
    }, LINK_CLOSE_GRACE_MS);
    const exited = () => clearTimeout(force);
    proc.child.once('exit', exited); force.unref?.();
  }

  private disconnect(): void {
    this.clearRetryWindow();
    this.linkGeneration++; this.connecting = false;
    if (this.respawn) { clearTimeout(this.respawn); this.respawn = null; }
    const link = this.link;
    this.link = null;
    if (link) this.closeLinkProcess(link);
    for (const done of [...this.connectionWaiters]) done(false);
    for (const w of [...this.waiters]) w.resolve(null);
  }

  private onLinkEvent(ev: HelperEvent): void {
    if (ev.ev === 'diagnostic' && typeof ev.stage === 'string'
      && ['sdp_start', 'sdp_done', 'rfcomm_start', 'rfcomm_existing', 'rfcomm_delegate', 'rfcomm_done', 'obex_connect', 'set_path'].includes(ev.stage)
      && typeof ev.result === 'number' && Number.isInteger(ev.result)) {
      console.log(`[phone-link] stage=${ev.stage} result=${ev.result}`); return;
    }
    if (ev.ev === 'link' && isLinkState(ev.state)) {
      // Native transport retries share the Global budget. Retain actionable
      // failures until success or explicit reconnect instead of a permanent spinner.
      if (ev.state === 'connecting' && ['unreachable', 'refused', 'lost', 'unpaired'].includes(this.state)) return;
      this.setState(ev.state); return;
    }
    if (ev.ev === 'latest') { if (typeof ev.body === 'string') this.receive(ev, false); else this.deps.changed(); return; }
    if (ev.ev === 'sms') this.receive(ev, true);
  }

  private onLinkExit(code: number | null): void {
    this.linkGeneration++; this.connecting = false;
    this.link = null;
    if (this.stopped || !this.binding()) return;
    if (code === 3 && !this.binding()?.last_connected_at) { this.clearRetryWindow(); this.setState('unsupported'); return; }
    const delay = code === 2 ? REPAIR_CHECK_MS : RESPAWN_DELAY_MS;
    console.warn(`[phone-link] 助手退出（code=${code}），${delay / 1000} 秒后重新检查已记住的手机`);
    this.setState(code === 2 ? 'unpaired' : 'lost');
    this.respawn = setTimeout(() => { this.respawn = null; void this.connect(); }, delay);
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
    this.latestFresh = fresh;
    console.log(`[phone-link] 收到验证码短信 signature=${sms.signature ?? '-'} fresh=${fresh}`);
    if (fresh) this.settleWaiters(sms);
    this.deps.changed();
  }

  private settleWaiters(sms: CodeSms): void {
    for (const w of [...this.waiters]) {
      if (!this.accepts(sms, w.opts)) continue;
      this.consume(sms, w.opts);
      w.resolve(sms);
    }
  }

  private setState(state: LinkState): void {
    if (['connected', 'paused', 'none', 'helper_missing'].includes(state)) this.clearRetryWindow();
    else if (state !== 'unsupported') this.beginRetryWindow();
    if (this.state === state) return;
    this.state = state;
    const binding = this.binding();
    if (state === 'connected' && binding) {
      this.deps.kvSet(PHONE_KV_KEY, { ...binding, last_connected_at: new Date(this.now()).toISOString() });
    }
    if (['connected', 'paused', 'none', 'unsupported', 'helper_missing'].includes(state)) {
      for (const done of [...this.connectionWaiters]) done(state === 'connected');
    }
    console.log(`[phone-link] state=${state}`);
    this.deps.changed();
  }
}
