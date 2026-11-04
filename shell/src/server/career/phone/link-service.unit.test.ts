import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HelperEvent, HelperProcess } from '../../utils/native-helper';
import { PhoneLinkService, signatureMatches, type PhoneLinkDeps } from './link-service';
import { PHONE_KV_KEY } from '../../../shared/careerPhone';

interface FakeProc { args: string[]; emit: (ev: HelperEvent) => void; exit: (code: number | null) => void; closed: boolean }

function setup(over: Partial<PhoneLinkDeps> = {}) {
  const kv = new Map<string, unknown>();
  const procs: FakeProc[] = [];
  let t = Date.parse('2026-11-03T04:27:00Z');
  const changed = vi.fn();
  const openBluetoothSettings = vi.fn(async () => {});
  const deps: PhoneLinkDeps = {
    platformSupported: true,
    kvGet: k => kv.get(k),
    kvSet: (k, v) => { kv.set(k, v); },
    spawn: async (args, onEvent, onExit) => {
      const fake: FakeProc = { args, emit: onEvent, exit: onExit, closed: false };
      procs.push(fake);
      const proc: HelperProcess = { child: new EventEmitter() as HelperProcess['child'], send: () => {}, close: () => { fake.closed = true; } };
      return proc;
    },
    openBluetoothSettings,
    changed,
    now: () => t,
    ...over,
  };
  return { svc: new PhoneLinkService(deps), deps, kv, procs, changed, openBluetoothSettings, tick: (ms: number) => { t += ms; } };
}

const MI10 = { address: 'e0-cc-f8-b6-28-12', name: 'Mi 10' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('PhoneLinkService', () => {
  it('绑定后启动 link，状态与最近一条验证码跟着助手走', async () => {
    const { svc, kv, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    expect(kv.get(PHONE_KV_KEY)).toMatchObject(MI10);
    expect(procs.at(-1)!.args).toEqual(['link', MI10.address]);
    procs.at(-1)!.emit({ ev: 'link', state: 'connected' });
    procs.at(-1)!.emit({ ev: 'latest', body: '【飞书招聘】MetaApp验证码：355161，请在 5 分钟内完成登录。', sender: '106948060400143', time: '20261103T122707' });
    const s = svc.status();
    expect(s.state).toBe('connected');
    expect(s.latest).toMatchObject({ code: '355161', signature: '飞书招聘', sender: '106948060400143' });
  });

  it('waitForCode 只认开始等之后、签名对得上的那条', async () => {
    const { svc, procs, tick } = setup();
    await svc.bind(MI10.address, MI10.name);
    const link = procs.at(-1)!;
    link.emit({ ev: 'latest', body: '【Moka招聘】您的验证码为030928，有效期15分钟。', sender: 'x', time: '20261103T110936' });
    const since = Date.parse('2026-11-03T04:27:00Z');
    const waiting = svc.waitForCode({ since, signature: '美团', timeoutMs: 60_000 });
    tick(2000);
    link.emit({ ev: 'sms', body: '【飞书招聘】MetaApp验证码：355161', sender: 'a', time: '20261103T122702' });
    tick(1000);
    link.emit({ ev: 'sms', body: '【美团】账号登录验证码：675054，该验证码10分钟内有效', sender: 'b', time: '20261103T122703' });
    await expect(waiting).resolves.toMatchObject({ code: '675054', signature: '美团' });
  });

  it('连上时报的历史短信不能拿去应付正在等的站点', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    const waiting = svc.waitForCode({ since: Date.parse('2026-11-03T04:27:00Z'), timeoutMs: 5_000 });
    procs.at(-1)!.emit({ ev: 'latest', body: '【飞书招聘】验证码：161049', sender: 'x', time: '20261103T121610' });
    vi.advanceTimersByTime(5_000);
    await expect(waiting).resolves.toBeNull();
  });

  it('strict 模式：拒绝旧码/签名包含匹配，同一短信只交给一个等待者', async () => {
    const since = new Date(2026, 10, 3, 12, 27, 0).getTime();
    const { svc, procs } = setup({ now: () => since + 2000 });
    await svc.bind(MI10.address, MI10.name);
    const link = procs.at(-1)!;
    const opts = { since, signature: '飞书招聘', timeoutMs: 5000, strict: true };
    const first = svc.waitForCode(opts); const second = svc.waitForCode(opts);
    link.emit({ ev: 'sms', body: '【飞书招聘】验证码：111111', sender: 'x', time: '20261103T112700' });
    link.emit({ ev: 'sms', body: '【飞书】验证码：222222', sender: 'x', time: '20261103T122702' });
    const good = { ev: 'sms', body: '【飞书招聘】验证码：333333', sender: 'x', time: '20261103T122702' };
    link.emit(good);
    await expect(first).resolves.toMatchObject({ code: '333333' });
    link.emit(good); // 助手重连重报也不能再消费
    vi.advanceTimersByTime(5000);
    await expect(second).resolves.toBeNull();
  });

  it('strict 模式不把重连的最近短信缓存当新码；取消/解绑立即清等待者', async () => {
    const since = new Date(2026, 10, 3, 12, 27, 0).getTime();
    const { svc, procs } = setup({ now: () => since });
    await svc.bind(MI10.address, MI10.name);
    procs.at(-1)!.emit({ ev: 'latest', body: '【飞书招聘】验证码：444444', sender: 'x', time: '20261103T122700' });
    const abort = new AbortController();
    const opts = { since, signature: '飞书招聘', timeoutMs: 5000, strict: true };
    const cancelled = svc.waitForCode({ ...opts, signal: abort.signal }); abort.abort();
    await expect(cancelled).resolves.toBeNull();
    const waiting = svc.waitForCode(opts); svc.unbind();
    await expect(waiting).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('重连后旧助手的事件和退出不能覆盖新连接或再启动一个助手', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    const old = procs[0]!;
    await svc.bind(MI10.address, MI10.name);
    procs[1]!.emit({ ev: 'link', state: 'connected' });
    old.emit({ ev: 'link', state: 'unreachable' });
    old.emit({ ev: 'sms', body: '验证码：123456', sender: 'fixture', time: '' });
    old.exit(0);
    expect(svc.status()).toMatchObject({ state: 'connected', latest: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(procs).toHaveLength(2);
  });

  it('后台重试不把连接失败重新遮成连接中，接通后才清除失败', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    const link = procs[0]!;
    for (const state of ['unreachable', 'refused', 'lost']) {
      link.emit({ ev: 'link', state });
      link.emit({ ev: 'link', state: 'connecting' });
      expect(svc.status().state).toBe(state);
    }
    link.emit({ ev: 'link', state: 'connected' });
    expect(svc.status().state).toBe('connected');
  });

  it('解绑期间才返回的助手必须关闭，不得恢复旧绑定的状态', async () => {
    const { svc, deps, procs } = setup();
    const spawn = deps.spawn;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.spawn = async (...args) => { const proc = await spawn(...args); await gate; return proc; };
    const binding = svc.bind(MI10.address, MI10.name);
    svc.unbind(); release?.(); await binding;
    expect(procs[0]!.closed).toBe(true);
    procs[0]!.emit({ ev: 'link', state: 'connected' });
    expect(svc.status()).toMatchObject({ state: 'none', binding: null });
  });

  it('诊断只记录允许的阶段与状态码，不输出额外正文', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      procs[0]!.emit({ ev: 'diagnostic', stage: 'obex_connect', result: -1, body: 'private-fixture' });
      procs[0]!.emit({ ev: 'diagnostic', stage: 'private-fixture', result: -1 });
      expect(log.mock.calls).toEqual([['[phone-link] stage=obex_connect result=-1']]);
    } finally { log.mockRestore(); }
  });

  it('掉线、再次靠近及进程重启均保留设备记忆，不再启动配对流程', async () => {
    const { svc, kv, procs, deps, tick, openBluetoothSettings } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs[0]!.emit({ ev: 'link', state: 'connected' });
    const remembered = svc.binding();
    expect(remembered?.last_connected_at).toBeTruthy();
    procs[0]!.emit({ ev: 'link', state: 'lost' });
    procs[0]!.emit({ ev: 'link', state: 'unreachable' });
    expect(svc.binding()).toEqual(remembered);
    tick(60_000); procs[0]!.emit({ ev: 'link', state: 'connected' });
    expect(svc.binding()?.bound_at).toBe(remembered?.bound_at);
    await svc.stop();
    const restarted = new PhoneLinkService(deps);
    await restarted.start();
    expect(procs.at(-1)?.args).toEqual(['link', MI10.address]);
    expect(kv.get(PHONE_KV_KEY)).toMatchObject(MI10);
    expect(openBluetoothSettings).not.toHaveBeenCalled();
    await restarted.stop();
  });

  it('再次选用同一手机、重试与修复配对都不清掉记忆', async () => {
    const { svc, procs, tick, openBluetoothSettings } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs[0]!.emit({ ev: 'link', state: 'connected' });
    const remembered = svc.binding(); tick(60_000);
    await svc.bind(MI10.address, MI10.name);
    expect(svc.binding()).toEqual(remembered);
    await svc.reconnect();
    expect(svc.binding()).toEqual(remembered);
    await svc.startPairing();
    expect(svc.binding()).toEqual(remembered);
    expect(procs.every(p => p.args[0] === 'link')).toBe(true);
    expect(openBluetoothSettings).toHaveBeenCalledOnce();
    await svc.stop();
  });

  it('助手暂报未配对：保留设备并自动重新检查，恢复配对后无需再选手机', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs[0]!.emit({ ev: 'link', state: 'unpaired' }); procs[0]!.exit(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(procs).toHaveLength(2);
    expect(svc.binding()).toMatchObject(MI10);
    procs[1]!.emit({ ev: 'link', state: 'connected' });
    expect(svc.status().state).toBe('connected');
    await svc.stop();
  });

  it('取消配对后迟到的 paired 事件不得重新绑定手机', async () => {
    const { svc, procs } = setup();
    await svc.startPairing(); const old = procs[0]!;
    svc.cancelPairing();
    old.emit({ ev: 'paired', ...MI10, phone: true });
    await Promise.resolve();
    expect(svc.binding()).toBeNull();
    expect(procs).toHaveLength(1);
  });

  it('启动幂等；助手退出后迟到的 connected 不能把离线标绿', async () => {
    const { svc, kv, procs } = setup();
    kv.set(PHONE_KV_KEY, { ...MI10, bound_at: '' });
    await Promise.all([svc.start(), svc.start()]);
    expect(procs).toHaveLength(1);
    procs[0]!.exit(1);
    procs[0]!.emit({ ev: 'link', state: 'connected' });
    expect(svc.status().state).toBe('lost');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(procs).toHaveLength(2);
    await svc.stop();
  });

  it('助手意外退出：标 lost，过一会重启', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs.at(-1)!.exit(1);
    expect(svc.status().state).toBe('lost');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(procs).toHaveLength(2);
    expect(procs[1]!.args).toEqual(['link', MI10.address]);
  });

  it('手机没有短信服务（退出码 3）：不重启', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs.at(-1)!.emit({ ev: 'link', state: 'unsupported' });
    procs.at(-1)!.exit(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(procs).toHaveLength(1);
    expect(svc.status().state).toBe('unsupported');
  });

  it('配对：打开蓝牙设置，等到新配对的手机就绑定并连接', async () => {
    const { svc, procs, openBluetoothSettings, kv } = setup();
    await svc.startPairing();
    expect(openBluetoothSettings).toHaveBeenCalled();
    expect(svc.status().pairing).toBe(true);
    procs[0]!.emit({ ev: 'paired', address: 'aa', name: '耳机', phone: false });
    expect(kv.get(PHONE_KV_KEY)).toBeUndefined();
    procs[0]!.emit({ ev: 'paired', ...MI10, phone: true });
    await vi.waitFor(() => expect(procs.at(-1)!.args).toEqual(['link', MI10.address]));
    expect(svc.status().pairing).toBe(false);
    expect(kv.get(PHONE_KV_KEY)).toMatchObject(MI10);
  });

  it('解绑：关掉助手、清空绑定和最近短信，不再重启', async () => {
    const { svc, procs, kv } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs[0]!.emit({ ev: 'sms', body: '验证码：1234', sender: 'x', time: '' });
    svc.unbind();
    expect(procs[0]!.closed).toBe(true);
    expect(kv.get(PHONE_KV_KEY)).toBeNull();
    expect(svc.status()).toMatchObject({ binding: null, state: 'none', latest: null });
    procs[0]!.exit(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(procs).toHaveLength(1);
  });

  it('断线总预算两分钟，反复事件不续期；休眠八小时不再启动助手', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    procs[0]!.emit({ ev: 'link', state: 'connected' });
    const remembered = svc.binding();
    procs[0]!.emit({ ev: 'link', state: 'lost' });
    await vi.advanceTimersByTimeAsync(110_000);
    procs[0]!.emit({ ev: 'link', state: 'connecting' });
    procs[0]!.emit({ ev: 'link', state: 'authorizing' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.status().state).toBe('paused');
    expect(procs[0]!.closed).toBe(true);
    expect(svc.binding()).toEqual(remembered);
    procs[0]!.emit({ ev: 'link', state: 'connected' }); procs[0]!.exit(0);
    await svc.start(); svc.status();
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(procs).toHaveLength(1);
    expect(svc.status().state).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('进程崩溃重启和未配对重查共享总预算，不能各自无限重试', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    for (let i = 0; i < 4; i++) {
      procs.at(-1)!.emit({ ev: 'link', state: 'unpaired' }); procs.at(-1)!.exit(2);
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(svc.status().state).toBe('paused');
    expect(procs).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(procs).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('手动唤醒只开新一轮；接通清掉计时，下一次断线重新计时', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    await vi.advanceTimersByTimeAsync(120_000);
    await svc.reconnect();
    expect(procs).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(110_000);
    procs[1]!.emit({ ev: 'link', state: 'connected' });
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000);
    expect(svc.status().state).toBe('connected');
    procs[1]!.emit({ ev: 'link', state: 'lost' });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(procs[1]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(svc.status().state).toBe('paused');
  });

  it('预算到期后才完成启动的助手也关闭', async () => {
    const { svc, deps, procs } = setup(); const spawn = deps.spawn;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    deps.spawn = async (...args) => { const proc = await spawn(...args); await gate; return proc; };
    const pending = svc.bind(MI10.address, MI10.name);
    await vi.advanceTimersByTimeAsync(120_000);
    release?.(); await pending;
    expect(procs[0]!.closed).toBe(true);
    expect(svc.status().state).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('真实收码需要时唤醒，共享同一轮预算，取消等待不会泄漏监听', async () => {
    const { svc, procs } = setup();
    await svc.bind(MI10.address, MI10.name);
    await vi.advanceTimersByTimeAsync(120_000);
    const abort = new AbortController();
    const cancelled = svc.ensureConnected(abort.signal);
    const ready = svc.ensureConnected(new AbortController().signal);
    expect(procs).toHaveLength(2);
    abort.abort(); await expect(cancelled).resolves.toBe(false);
    procs[1]!.emit({ ev: 'link', state: 'connected' });
    await expect(ready).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    procs[1]!.emit({ ev: 'link', state: 'lost' });
    const absent = svc.ensureConnected(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(absent).resolves.toBe(false);
    expect(svc.status().state).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('原生助手不响应退出时只强制终止自己持有的子进程', async () => {
    const child = new ChildProcess(); const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
    const close = vi.fn();
    const { svc } = setup({ spawn: async () => ({ child, send: vi.fn(), close }) });
    await svc.bind(MI10.address, MI10.name);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('非 macOS：不启动助手', async () => {
    const spawn = vi.fn();
    const { svc } = setup({ platformSupported: false, spawn });
    await svc.startPairing();
    expect(await svc.pairedPhones()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(svc.status().platform_supported).toBe(false);
  });
});

describe('signatureMatches', () => {
  it('去掉「招聘」等修饰后互相包含就算对上', () => {
    expect(signatureMatches('飞书', '飞书招聘')).toBe(true);
    expect(signatureMatches('美团', '飞书招聘')).toBe(false);
    expect(signatureMatches(null, null)).toBe(true);
    expect(signatureMatches('美团', null)).toBe(false);
  });
});
