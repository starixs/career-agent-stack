/**
 * 浏览器工作面（specs/CAREER_DESIGN.md §5.7 收起 / 展开 / 交接）：
 *  - `CareerLiveDrawer` 挂在 App 根上，只负责把事件变成状态：打开请求、助理 ui_open(live)、
 *    交接暂停、页面请求选文件 → 展开对话页右侧的浏览器栏并切到对话；同时记录接管与进度。
 *  - `BrowserSessionPanel` 是展开后的右侧栏：实时画面、停止、控制浏览器 / 交还给小芽、全屏、
 *    选文件、临时显示真实窗口。关闭只是收起，后台填表 / 批量不受影响。
 * 浏览器只在产品里出现，不弹真实 Chrome 窗口。
 */
import { AppWindow, Lock, Maximize2, Minimize2, Paperclip, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import { emitEvent, onEvent } from '@/api/eventBus';
import { requestNavigation } from '@/features/career-shell/navModel';
import {
  collapseWorkSurface,
  expandWorkSurface,
  recordProgress,
  settleProgressRuns,
  recordTakeover,
  setWorkSurfaceFullscreen,
  useWorkSurfaces,
} from '@/features/career-shell/workSurfaceStore';

import { dispatchTakeoverAction } from './BrowserStatusBar';
import { careerApi } from './careerApi';
import { HANDOFF_REASON_LABELS } from './careerConstants';
import { DRAWER_OPENED_EVENT } from './careerDrawers';
import { CareerLiveViewport } from './CareerLiveViewport';
import { Button, suggestToChat } from './CareerPrimitives';
import type { BatchState, CareerProgressEvent, CareerTakeoverEvent, LiveFileChooser, LiveFileChooserEvent, LiveFrame, LiveSnapshot, LiveStreamEvent } from './types';
import { useLiveStream } from './useGlobalLive';

const DRAWER_EVENT = 'career:live-drawer';
const FILE_EVENT = 'career:live-filechooser';
export function openLiveDrawer(options: { fullscreen?: boolean } = {}): void { emitEvent(DRAWER_EVENT, { open: true, ...options }); }

/** 展开浏览器栏，并把用户带到唯一的对话页（栏长在对话页右侧）。 */
function showBrowserSurface(options: { fullscreen?: boolean } = {}): void {
  expandWorkSurface('browser', options);
  emitEvent(DRAWER_OPENED_EVENT, { name: 'live' });
  requestNavigation({ kind: 'chat' });
}

/** App 根上的事件控制器：不渲染任何东西。 */
export function CareerLiveDrawer({ autoOpenOnHandoff = true }: { autoOpenOnHandoff?: boolean }) {
  useEffect(() => onEvent<{ open?: boolean; fullscreen?: boolean }>(DRAWER_EVENT, p => {
    if (p?.open === false) collapseWorkSurface('browser');
    else showBrowserSurface({ fullscreen: p?.fullscreen });
  }), []);
  // 助理调用 ui_open(live)：career:focus {surface:'live_drawer'}
  useEffect(() => onEvent<{ surface?: string }>('career:focus', p => {
    if (p?.surface === 'live_drawer') showBrowserSurface();
  }), []);
  // 抽屉互斥：简历编辑器打开时收起浏览器栏
  useEffect(() => onEvent<{ name?: string }>(DRAWER_OPENED_EVENT, p => { if (p?.name !== 'live') collapseWorkSurface('browser'); }), []);
  useEffect(() => onEvent<CareerTakeoverEvent>('career:takeover', p => {
    if (!p?.runId) return;
    recordTakeover(p);
    if (autoOpenOnHandoff && p.state === 'paused') showBrowserSurface();
  }), [autoOpenOnHandoff]);
  useEffect(() => onEvent<CareerProgressEvent>('career:progress', p => { if (p) recordProgress(p); }), []);
  useEffect(() => onEvent('career:progress-settled', () => settleProgressRuns()), []);
  // 页面请求选文件：系统框被拦下了，必须展开浏览器栏让用户在产品里选
  useEffect(() => onEvent<LiveFileChooserEvent>(FILE_EVENT, p => { if (p?.state === 'open') showBrowserSurface(); }), []);
  return null;
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).host; } catch { return null; }
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

export interface BrowserSessionPanelProps {
  /** Stops the assistant's current turn when no batch is running (owned by Chat). */
  onStop?: () => void;
}

/** 展开态：对话页右侧的浏览器会话栏。 */
export function BrowserSessionPanel({ onStop }: BrowserSessionPanelProps) {
  const { takeover, fullscreen } = useWorkSurfaces();
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
      case 'career:takeover': recordTakeover(ev as unknown as CareerTakeoverEvent); return;
      case FILE_EVENT: {
        const f = ev as unknown as LiveFileChooserEvent;
        if (f.state === 'open') setChooser({ id: f.id, sessionId: f.sessionId ?? '', multiple: f.multiple === true, accept: f.accept ?? null, url: f.url ?? '', ts: f.ts ?? Date.now() });
        else setChooser(c => (c?.id === f.id ? null : c));
        return;
      }
      case 'career:live-window': setRevealed((ev as { revealed?: boolean }).revealed === true); return;
      default: return;
    }
  }, []);
  const stream = useLiveStream(true, onEventCb);

  const control = snapshot?.browser.control ?? 'none';
  const humanActive = control === 'human' || takeover?.state === 'human_active';
  const embedded = snapshot?.browser.embedded === true;

  const act = async (action: 'take' | 'handback'): Promise<boolean> => {
    setBusy(action); setNotice(null);
    const viaRun = Boolean(takeover?.runId && takeover.runId !== 'live')
    const ok = viaRun && takeover
      ? await dispatchTakeoverAction(takeover.runId, action)
      : await careerApi.liveControl(action === 'take' ? 'human' : 'agent', action === 'take' ? 'user_request' : undefined).then(() => true).catch(() => false);
    setBusy(null);
    if (!ok) { setNotice('操作失败，请重试'); return false; }
    setSnapshot(s => (s ? { ...s, browser: { ...s.browser, control: action === 'take' ? 'human' : 'agent' } } : s));
    recordTakeover(takeover ? { ...takeover, state: action === 'take' ? 'human_active' : 'resuming' } : takeover);
    // 交回后：走 run 的由会话的接管交接统一通知助理（只在对话发起的填写上，批量自己续跑）；
    // 直接切控制权的这条没有 run，批量没在跑时让助理接着填（apply_continue）
    if (action === 'handback' && !viaRun && batch?.status !== 'running') suggestToChat('浏览器里的事我已经处理完并交回了，请从当前页继续填表');
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

  const handoff = takeover?.state === 'paused';
  const host = hostOf(snapshot?.browser.url);
  const statusTone = handoff || humanActive ? 'bg-[var(--warning)]' : control === 'agent' ? 'bg-[var(--success)]' : 'bg-[var(--subtle)]';
  const statusText = handoff
    ? `等你处理${reason ? `：${reason}` : ''}`
    : humanActive ? '你在控制中' : control === 'agent' ? '正在工作' : '浏览器未打开';
  const stop = async () => {
    setNotice(null);
    if (batch?.status === 'running' || batch?.status === 'paused') {
      try { setBatch((await careerApi.batchCommand('stop')) ?? batch); } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
      return;
    }
    onStop?.();
  };

  return (
    <section
      data-testid="career-live-drawer"
      data-fullscreen={fullscreen ? 'true' : 'false'}
      aria-label="浏览器会话"
      className={fullscreen
        ? 'fixed inset-0 z-40 flex flex-col bg-[var(--side)]'
        : 'flex h-full min-w-0 flex-1 flex-col border-l border-[var(--line)] bg-[var(--side)]'}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="font-human text-lg font-semibold text-[var(--ink)]">浏览器会话</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone}`} aria-hidden="true" />
            <span className="truncate">{statusText}{host ? ` · ${host}` : ''}</span>
            <span className="ml-2 shrink-0 text-[var(--subtle)]">{stream.status === 'open' ? '直播中' : stream.status === 'connecting' ? '连接中…' : '重连中'}</span>
          </div>
        </div>
        {(control === 'agent' || batch?.status === 'running') && (
          <Button variant="ghost" onClick={() => void stop()} className="text-[var(--danger)]">
            <Square className="h-3.5 w-3.5" />停止
          </Button>
        )}
        {!humanActive && <Button variant="primary" busy={busy === 'take'} disabled={!canTake} onClick={() => void act('take')}>控制浏览器</Button>}
        {humanActive && <Button variant="primary" busy={busy === 'handback'} disabled={busy !== null} onClick={() => void act('handback')}>交还给小芽</Button>}
        <Button variant="ghost" onClick={() => setWorkSurfaceFullscreen(!fullscreen)} aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏，回到侧栏' : '全屏操作'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" onClick={() => collapseWorkSurface('browser')} aria-label="收起浏览器"><X className="h-3.5 w-3.5" /></Button>
      </header>

      {(handoff || humanActive) && (
        <div role="status" className="mx-5 mt-3 flex items-start gap-2.5 rounded-lg border border-[var(--hard)] bg-[var(--note)] px-3.5 py-2.5 text-sm text-[var(--ink)] shadow-[var(--theme-shadow-hard)]">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-human font-semibold">这一步要你本人来{reason ? `：${reason}` : ''}</div>
            <div className="text-xs text-[var(--ink-2)]">
              {takeover?.message ?? (humanActive
                ? '直接在画面里点、输入、滚动；做完点「交还给小芽」。'
                : '点画面或「控制浏览器」接手，完成后交还给小芽。')}
            </div>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
        <div className="overflow-hidden rounded-lg border border-[var(--line-2)] bg-[var(--paper)] shadow-md">
          <CareerLiveViewport
            frame={frame}
            interactive={humanActive}
            onInputError={setNotice}
            onRequestControl={canTake ? () => act('take') : undefined}
            style={viewportStyle}
            placeholder={frameError ?? (snapshot && !snapshot.browser.hasBrowser ? '浏览器还没有打开。小芽开始填表后画面会出现。' : '等待画面…')}
          />
        </div>
        {chooser && <FileChooserPanel key={chooser.id} chooser={chooser} onDone={msg => { setChooser(null); setInfo(msg); }} />}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {snapshot?.browser.url && <span className="min-w-0 flex-1 truncate text-[var(--subtle)]" title={snapshot.browser.url}>{snapshot.browser.title || snapshot.browser.url}</span>}
          {embedded && snapshot?.browser.hasBrowser && (
            <Button variant="ghost" busy={busy === 'window'} disabled={busy !== null} onClick={() => void toggleWindow()} title="画面里处理不了时（插件弹窗等）临时显示真实 Chrome 窗口">
              <AppWindow className="h-3.5 w-3.5" />{revealed ? '收回真实窗口' : '显示真实窗口'}
            </Button>
          )}
          {notice && <span role="alert" className="text-[var(--danger)]">{notice}</span>}
          {!notice && info && <span role="status" className="text-[var(--success)]">{info}</span>}
        </div>
        {batch && batch.status !== 'idle' && (
          <div className="mt-3 rounded-md border border-[var(--line)] bg-[var(--inset)] px-3 py-2 text-xs text-[var(--muted)]">
            批量：{batch.message ?? batch.status} · 已填好 {batch.done} · 等你处理 {batch.handoffs} · 队列 {batch.queued}
          </div>
        )}
      </div>
    </section>
  );
}
