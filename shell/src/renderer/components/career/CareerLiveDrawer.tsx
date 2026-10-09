/**
 * 聊天旁的"浏览器现场"侧边抽屉：浏览器只在产品里出现，不弹真实 Chrome 窗口。
 *  - 打开：eventBus `career:live-drawer {open:true}`（接管卡片、状态条按钮），接管事件进入 paused、
 *    或页面请求选文件时自动弹出；
 *  - 接管：点「接管」或直接点画面（先接管，再把这一下点击转发）；之后点击 / 输入 / 滚动都在画面里完成；
 *  - 全屏：抽屉可铺满整个窗口，退出全屏回到侧栏，后台运行不受影响；
 *  - 选文件：页面里点「上传附件」时，系统选文件框被拦下，这里出现「选择文件」，选好后交回页面；
 *  - 逃生口：插件弹窗等画面里处理不了的情况，可临时显示真实窗口，用完收回。
 *  - 关闭：只是收起画面，后台填表 / 批量不受影响。
 * 挂在 App 根上，所有页签都能用。
 */
import { AppWindow, Eye, Maximize2, Minimize2, Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';

import { dispatchTakeoverAction } from './BrowserStatusBar';
import { careerApi } from './careerApi';
import { HANDOFF_REASON_LABELS } from './careerConstants';
import { DRAWER_OPENED_EVENT } from './careerDrawers';
import { CareerLiveViewport } from './CareerLiveViewport';
import { Badge, Button, suggestToChat } from './CareerPrimitives';
import type { BatchState, CareerTakeoverEvent, LiveFileChooser, LiveFileChooserEvent, LiveFrame, LiveSnapshot, LiveStreamEvent } from './types';
import { useLiveStream } from './useGlobalLive';

const DRAWER_EVENT = 'career:live-drawer';
const FILE_EVENT = 'career:live-filechooser';
export function openLiveDrawer(options: { fullscreen?: boolean } = {}): void { emitEvent(DRAWER_EVENT, { open: true, ...options }); }

export function CareerLiveDrawer({ autoOpenOnHandoff = true }: { autoOpenOnHandoff?: boolean }) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [takeover, setTakeover] = useState<CareerTakeoverEvent | null>(null);
  useEffect(() => onEvent<{ open?: boolean; fullscreen?: boolean }>(DRAWER_EVENT, p => {
    setOpen(p?.open !== false);
    if (typeof p?.fullscreen === 'boolean') setFullscreen(p.fullscreen);
    if (p?.open !== false) emitEvent(DRAWER_OPENED_EVENT, { name: 'live' });
  }), []);
  // 助理调用 ui_open(live)：career:focus {surface:'live_drawer'}
  useEffect(() => onEvent<{ surface?: string }>('career:focus', p => {
    if (p?.surface === 'live_drawer') { setOpen(true); emitEvent(DRAWER_OPENED_EVENT, { name: 'live' }); }
  }), []);
  // 抽屉互斥：简历编辑器打开时收起现场
  useEffect(() => onEvent<{ name?: string }>(DRAWER_OPENED_EVENT, p => { if (p?.name !== 'live') setOpen(false); }), []);
  useEffect(() => onEvent<CareerTakeoverEvent>('career:takeover', p => {
    if (!p?.runId) return;
    setTakeover(p);
    if (autoOpenOnHandoff && p.state === 'paused') setOpen(true);
  }), [autoOpenOnHandoff]);
  // 页面请求选文件：系统框被拦下了，必须把抽屉打开让用户在产品里选
  useEffect(() => onEvent<LiveFileChooserEvent>(FILE_EVENT, p => { if (p?.state === 'open') setOpen(true); }), []);
  if (!open) return null;
  return (
    <DrawerBody
      takeover={takeover}
      fullscreen={fullscreen}
      onToggleFullscreen={() => setFullscreen(f => !f)}
      onClose={() => { setOpen(false); setFullscreen(false); }}
      onTakeoverChange={setTakeover}
    />
  );
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function FileChooserPanel({ chooser, onDone }: { chooser: LiveFileChooser; onDone: (message: string | null) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onPick = async (ev: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = '';
    if (!files.length) return;
    setBusy(true); setError(null);
    try {
      const payload = await Promise.all(files.map(async f => ({ name: f.name, mimeType: f.type || undefined, data: await readAsBase64(f) })));
      await careerApi.liveFile(chooser.id, payload);
      onDone(`已上传 ${files.map(f => f.name).join('、')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    await careerApi.liveFileCancel(chooser.id).catch(() => false);
    setBusy(false);
    onDone(null);
  };
  return (
    <div data-testid="live-file-chooser" role="dialog" aria-label="页面请求上传文件" className="mt-2 rounded-md border border-[var(--primary)]/50 bg-[var(--inset)] px-3 py-2 text-xs text-[var(--ink)]">
      <div className="flex items-center gap-1.5 font-medium"><Paperclip className="h-3.5 w-3.5" />页面请求上传文件{chooser.accept ? `（${chooser.accept}）` : ''}</div>
      <p className="mt-1 text-[var(--muted)]">在这里选文件，会直接交给网页里的上传框，不会弹出别的窗口。</p>
      <input
        ref={inputRef}
        type="file"
        data-testid="live-file-input"
        className="hidden"
        multiple={chooser.multiple}
        accept={chooser.accept ?? undefined}
        onChange={ev => void onPick(ev)}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button variant="primary" busy={busy} onClick={() => inputRef.current?.click()}>选择文件</Button>
        <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>取消</Button>
        {error && <span role="alert" className="text-[var(--danger)]">{error}</span>}
      </div>
    </div>
  );
}

function DrawerBody({ takeover, fullscreen, onToggleFullscreen, onClose, onTakeoverChange }: {
  takeover: CareerTakeoverEvent | null;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
  onTakeoverChange: (t: CareerTakeoverEvent | null) => void;
}) {
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'take' | 'handback' | 'window' | null>(null);
  const [chooser, setChooser] = useState<LiveFileChooser | null>(null);
  const [revealed, setRevealed] = useState(false);

  const onEventCb = useCallback((ev: LiveStreamEvent) => {
    switch (ev.type) {
      case 'frame': setFrame(ev as LiveFrame); setFrameError(null); return;
      case 'snapshot': {
        const s = ev as LiveStreamEvent & LiveSnapshot;
        setSnapshot(s);
        if (s.batch) setBatch(s.batch);
        setChooser(s.fileChooser ?? null);
        setRevealed(s.browser.windowRevealed === true);
        return;
      }
      case 'frame-error': setFrameError(String((ev as { error: string }).error)); return;
      case 'career:batch': setBatch(ev as unknown as BatchState); return;
      case 'career:takeover': onTakeoverChange(ev as unknown as CareerTakeoverEvent); return;
      case FILE_EVENT: {
        const f = ev as unknown as LiveFileChooserEvent;
        if (f.state === 'open') setChooser({ id: f.id, sessionId: f.sessionId ?? '', multiple: f.multiple === true, accept: f.accept ?? null, url: f.url ?? '', ts: f.ts ?? Date.now() });
        else setChooser(c => (c?.id === f.id ? null : c));
        return;
      }
      case 'career:live-window': setRevealed((ev as { revealed?: boolean }).revealed === true); return;
      default: return;
    }
  }, [onTakeoverChange]);
  const stream = useLiveStream(true, onEventCb);

  const control = snapshot?.browser.control ?? 'none';
  const humanActive = control === 'human' || takeover?.state === 'human_active';
  const embedded = snapshot?.browser.embedded === true;

  const act = async (action: 'take' | 'handback'): Promise<boolean> => {
    setBusy(action); setNotice(null);
    const ok = takeover?.runId && takeover.runId !== 'live'
      ? await dispatchTakeoverAction(takeover.runId, action)
      : await careerApi.liveControl(action === 'take' ? 'human' : 'agent', action === 'take' ? 'user_request' : undefined).then(() => true).catch(() => false);
    setBusy(null);
    if (!ok) { setNotice('操作失败，请重试'); return false; }
    setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: action === 'take' ? 'human' : 'agent' } } : s));
    onTakeoverChange(takeover ? { ...takeover, state: action === 'take' ? 'human_active' : 'resuming' } : takeover);
    // 交回后：批量运行器会自己从当前页继续；单次填表要让对话里的助理接着填（apply_continue）
    if (action === 'handback' && batch?.status !== 'running') suggestToChat('浏览器里的事我已经处理完并交回了，请从当前页继续填表');
    return true;
  };
  const toggleWindow = async () => {
    setBusy('window'); setNotice(null);
    try { setRevealed(await careerApi.liveWindow(!revealed)); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
  };
  const reason = takeover?.reason ? (HANDOFF_REASON_LABELS[takeover.reason] ?? takeover.reason) : null;
  const canTake = !!snapshot?.browser.hasBrowser && busy === null;
  const viewportStyle = fullscreen && frame?.width && frame.height
    ? { maxWidth: `calc((100vh - 170px) * ${frame.width / frame.height})`, marginInline: 'auto' }
    : undefined;

  return (
    <aside
      data-testid="career-live-drawer"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      aria-label="浏览器现场"
      className={`fixed z-40 flex flex-col bg-[var(--bg)] shadow-2xl ${fullscreen ? 'inset-0' : 'inset-y-0 right-0 w-[min(560px,92vw)] border-l border-[var(--line)]'}`}
    >
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-xs text-[var(--muted)]">
        <Eye className="h-3.5 w-3.5" />
        <span className="text-sm font-medium text-[var(--ink)]">浏览器现场</span>
        <Badge tone={control === 'human' ? 'info' : control === 'agent' ? 'success' : 'neutral'}>{control === 'human' ? '你在操作' : control === 'agent' ? '助理在操作' : '浏览器未打开'}</Badge>
        {takeover?.state === 'paused' && <Badge tone="warning">等你处理{reason ? `：${reason}` : ''}</Badge>}
        <span className="ml-auto">{stream.status === 'open' ? '直播中' : stream.status === 'connecting' ? '连接中…' : '重连中'}</span>
        <Button variant="ghost" onClick={onToggleFullscreen} aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏，回到侧栏' : '全屏操作'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" onClick={onClose} aria-label="收起现场"><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <CareerLiveViewport
          frame={frame}
          interactive={humanActive}
          onInputError={setNotice}
          onRequestControl={canTake ? () => act('take') : undefined}
          style={viewportStyle}
          placeholder={frameError ?? (snapshot && !snapshot.browser.hasBrowser ? '浏览器还没有打开。助理开始填表后画面会出现。' : '等待画面…')}
        />
        {chooser && <FileChooserPanel key={chooser.id} chooser={chooser} onDone={msg => { setChooser(null); setInfo(msg); }} />}
        {takeover?.message && takeover.state === 'paused' && (
          <div role="status" className="mt-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--ink)]">{takeover.message}</div>
        )}
        {snapshot?.browser.url && <div className="mt-2 truncate text-xs text-[var(--subtle)]" title={snapshot.browser.url}>{snapshot.browser.title || snapshot.browser.url}</div>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!humanActive && <Button variant="primary" busy={busy === 'take'} disabled={!canTake} onClick={() => void act('take')}>接管</Button>}
          {humanActive && <Button variant="primary" busy={busy === 'handback'} disabled={busy !== null} onClick={() => void act('handback')}>交回，继续</Button>}
          {!fullscreen && <Button variant="ghost" onClick={onToggleFullscreen}><Maximize2 className="h-3.5 w-3.5" />全屏操作</Button>}
          {embedded && snapshot?.browser.hasBrowser && (
            <Button variant="ghost" busy={busy === 'window'} disabled={busy !== null} onClick={() => void toggleWindow()} title="画面里处理不了时（插件弹窗等）临时显示真实 Chrome 窗口">
              <AppWindow className="h-3.5 w-3.5" />{revealed ? '收回真实窗口' : '显示真实窗口'}
            </Button>
          )}
          {notice && <span role="alert" className="text-xs text-[var(--danger)]">{notice}</span>}
          {!notice && info && <span role="status" className="text-xs text-[var(--success)]">{info}</span>}
        </div>
        <p className="mt-2 text-xs text-[var(--subtle)]">
          {humanActive
            ? '直接在画面里点、输入、滚动；上传附件会在这里让你选文件。做完点「交回，继续」。'
            : '遇到登录 / 滑块 / 短信码时，直接点画面即可接管，浏览器一直留在产品里。'}
        </p>
        {batch && batch.status !== 'idle' && (
          <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--inset)] px-3 py-2 text-xs text-[var(--muted)]">
            批量：{batch.message ?? batch.status} · 已填好 {batch.done} · 等你处理 {batch.handoffs} · 队列 {batch.queued}
          </div>
        )}
      </div>
    </aside>
  );
}
