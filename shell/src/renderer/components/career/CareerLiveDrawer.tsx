/**
 * 浏览器工作面（specs/CAREER_DESIGN.md §5.7 收起 / 展开 / 交接）：
 *  - `CareerLiveDrawer` 挂在 App 根上，只负责把事件变成状态：打开请求、助理 ui_open(live)、
 *    交接暂停、页面请求选文件 → 展开对话页右侧的浏览器栏并切到对话；同时记录接管与进度。
 *  - `BrowserSessionPanel` 是展开后的右侧栏：实时画面、停止、我来操作 / 交还给小芽、全屏、
 *    选文件、当前任务与分组进度。关闭只是收起，后台填表 / 批量不受影响。
 * 浏览器只在产品里出现，不弹真实 Chrome 窗口。
 */
import { Maximize2, Minimize2, Paperclip, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';

import { apiGetJson, apiPostJson } from '@/api/apiFetch';
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
import { CareerLiveViewport, liveHumanActive } from './CareerLiveViewport';
import { LivePageTabs, parseLivePages } from './LivePageTabs';
import { TaskProgressPanel } from './TaskProgressPanel';
import { SmsCodeBar } from './SmsCodeBar';
import { useCareerQuery } from './useCareerData';
import { readAsBase64 } from './fileBase64';
import { Button, suggestToChat } from './CareerPrimitives';
import type { BatchState, CareerProgressEvent, CareerTakeoverEvent, LiveFileChooser, LiveFileChooserEvent, LiveFrame, LiveSnapshot, LiveStreamEvent, LiveFrameStatus } from './types';
import { liveStatusText } from './types';
import { useLiveStream } from './useGlobalLive';

const DRAWER_EVENT = 'career:live-drawer';
const FILE_EVENT = 'career:live-filechooser';
export function openLiveDrawer(options: { fullscreen?: boolean } = {}): void { emitEvent(DRAWER_EVENT, { open: true, ...options }); }

/**
 * 展开浏览器栏。只有他自己点「去看」（openLiveDrawer）才把他带到对话页（栏长在对话页右侧）；
 * 后台的事（某家要他接手、小芽说开现场、网页要选文件）只把栏备好，不把他从正在看的页面拽走——
 * 他回到对话页时栏已经开着，等你的事由「等你」提醒（2026-11-03 用户：连邮箱时被一次次顶回对话页，后台网申成了前台）。
 */
function showBrowserSurface(options: { fullscreen?: boolean; navigate?: boolean } = {}): void {
  const { navigate = false, ...surface } = options;
  expandWorkSurface('browser', surface);
  emitEvent(DRAWER_OPENED_EVENT, { name: 'live' });
  if (navigate) requestNavigation({ kind: 'chat' });
}

/** App 根上的事件控制器：不渲染任何东西。 */
export function CareerLiveDrawer({ autoOpenOnHandoff = true }: { autoOpenOnHandoff?: boolean }) {
  useEffect(() => onEvent<{ open?: boolean; fullscreen?: boolean }>(DRAWER_EVENT, p => {
    if (p?.open === false) collapseWorkSurface('browser');
    else showBrowserSurface({ fullscreen: p?.fullscreen, navigate: true });
  }), []);
  // 助理调用 ui_open(live)：career:focus {surface:'live_drawer'}
  useEffect(() => onEvent<{ surface?: string; origin?: string }>('career:focus', p => {
    // 他在右栏 / 等你里点「去看」才跳到对话页；小芽推来的只把栏备好
    if (p?.surface === 'live_drawer') showBrowserSurface({ navigate: p.origin !== 'assistant' });
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
      {/* 只说这一步要他做什么；网页给的格式代码（一长串 MIME）和「不会弹窗」的解释不上页面，格式由选文件框自己限制 */}
      <div className="flex items-center gap-1.5 font-medium"><Paperclip className="h-3.5 w-3.5" />这一页要你传一个文件</div>
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

/** 画面区下方的地址行 / 批量进度等占的高度（上报可用画面框时扣掉）。 */
const LIVE_FRAME_CHROME_PX = 72;
const LIVE_VIEWPORT_DEBOUNCE_MS = 250;

/**
 * 把画面区可用的框（CSS 像素）上报给 Global：页面视口按它的比例调整，画面一打开就对得上，
 * 侧栏 / 全屏 / 窗口拖动时自动跟随；浏览器后打开时（hasBrowser 变 true）再报一次。
 */
function useLiveViewportSync(hostRef: { current: HTMLElement | null }, hasBrowser: boolean, fullscreen: boolean): void {
  const last = useRef<{ width: number; height: number } | null>(null);
  useEffect(() => { last.current = null; }, [hasBrowser]);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      const style = getComputedStyle(el);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const width = Math.round(el.clientWidth - padX);
      const height = Math.round(el.clientHeight - padY - LIVE_FRAME_CHROME_PX);
      if (width < 120 || height < 120) return;
      const prev = last.current;
      if (prev && Math.abs(prev.width - width) < 8 && Math.abs(prev.height - height) < 8) return;
      last.current = { width, height };
      void apiPostJson<unknown>('/api/career/live/viewport', { width, height }).catch(() => { last.current = null; });
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(report, LIVE_VIEWPORT_DEBOUNCE_MS); };
    schedule();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(el);
    return () => { observer?.disconnect(); if (timer) clearTimeout(timer); };
  }, [hostRef, hasBrowser, fullscreen]);
}

export interface BrowserSessionPanelProps {
  /** Stops the assistant's current turn when no batch is running (owned by Chat). */
  onStop?: () => void;
}

/** 交还后替你说的一句（不用你打字）；助理该调哪个工具放在隐藏 note 里。 */
export const HANDBACK_TEXT = '浏览器里的事我处理好了，交还给你，接着办吧。';
const HANDBACK_NOTE = '用户在浏览器现场处理完并点了交还：之前 browser_wait_user 没等到的，先 browser_observe 看一眼再接着做原来的事；对话里 apply_run 发起的填表，调用 apply_continue(action_id) 从当前页继续。';

/**
 * 交还后要不要替你跟助理说一声：
 *  - 走 run 的：会话的接管交接已经通知了助理；后台批量在跑：它自己从当前页续；
 *  - 助理还在 browser_wait_user 里等着：等待自己会看到交还，再说一句就成了同一件事叫两次。
 * 其余（等待已超时、助理已收尾这一轮）才说，免得你交还后还得回对话打「好了」。
 */
export function handbackNeedsAssistant({ viaRun, batch, snapshot }: { viaRun: boolean; batch: BatchState | null; snapshot: LiveSnapshot | null }): boolean {
  return !viaRun && batch?.status !== 'running' && snapshot?.waitingUser !== true;
}

/** 交还那一刻重新取一次现场状态（流里的快照只在连上 / 画面接上时推，「助理在不在等」可能已经变了）；取不到用手上的。 */
async function freshSnapshot(cur: LiveSnapshot | null): Promise<LiveSnapshot | null> {
  try { return await careerApi.liveState(); } catch (error) {
    console.warn('[career-live] handback state refresh FAILED', error instanceof Error ? error.message : error);
    return cur;
  }
}

/** 等你处理 / 你在操作时，每隔几秒刷新一次现场状态：登录之旅切到下一家时「第几家」跟着变。 */
const TAKEOVER_REFRESH_MS = 3000;

/** 状态行：登录之旅里带上「第几家 / 共几家」，一家家过时知道还剩多少。 */
export function journeyText(journey: LiveSnapshot['journey']): string {
  return journey && journey.total > 1 ? `登录第 ${journey.index + 1} / ${journey.total} 家` : '';
}

/** 展开态：对话页右侧的网申现场栏。 */
export function BrowserSessionPanel({ onStop }: BrowserSessionPanelProps) {
  const { takeover, fullscreen, runs } = useWorkSurfaces();
  // 开着页面的几份网申：顶上的标签和下面的流程共用这一份（哪边切，画面和两处都跟着）
  const { data: pageData, reload: reloadPages } = useCareerQuery(async () => parseLivePages(await apiGetJson<unknown>('/api/career/live/pages')), ['action_queue', 'handoff', 'live_view']);
  const pages = pageData ?? [];
  const shownPage = pages.find(p => p.current);
  // 画面正看着某一家：只讲这一家；没有网申页面开着时讲最近在做的那件事
  const shownRun = shownPage ? runs.find(r => r.applicationId === shownPage.application_id) : runs.find(r => !r.finished) ?? runs[0];
  const showPage = (applicationId: string) => {
    void apiPostJson<unknown>('/api/career/live/view', { application_id: applicationId })
      .then(reloadPages, (e: unknown) => { console.error('[career-live] 切换现场 FAILED', applicationId, e instanceof Error ? e.message : e); reloadPages(); });
  };
  const [frame, setFrame] = useState<LiveFrame | null>(null);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<'take' | 'handback' | null>(null);
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
      case 'frame-status': { const st = ev as unknown as LiveFrameStatus; if (st.state !== 'connecting') setFrame(null); setFrameError(liveStatusText(st)); return; }
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
  const frameHostRef = useRef<HTMLDivElement | null>(null);
  useLiveViewportSync(frameHostRef, snapshot?.browser.hasBrowser === true, fullscreen);

  const control = snapshot?.browser.control ?? 'none';
  const humanActive = liveHumanActive(snapshot?.browser.control, takeover?.state);

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
    if (action === 'handback' && handbackNeedsAssistant({ viaRun, batch, snapshot: await freshSnapshot(snapshot) })) suggestToChat(HANDBACK_TEXT, { surface: 'apply', note: HANDBACK_NOTE });
    return true;
  };
  const reason = takeover?.reason ? (HANDOFF_REASON_LABELS[takeover.reason] ?? takeover.reason) : null;
  const canTake = !!snapshot?.browser.hasBrowser && busy === null;
  const viewportStyle = fullscreen && frame?.width && frame.height
    ? { maxWidth: `calc((100vh - 170px) * ${frame.width / frame.height})`, marginInline: 'auto' }
    : undefined;

  const handoff = takeover?.state === 'paused';
  // 登录之旅里也要跟着刷：短信码那一格（已发码 / 要先过拼图）随着这一家变
  const attending = handoff || humanActive || !!snapshot?.journey || !!snapshot?.sms;
  useEffect(() => {
    if (!attending) return;
    const t = window.setInterval(() => { void careerApi.liveState().then(setSnapshot).catch(error => console.debug('[career-live] takeover state refresh failed; retry next tick', error)); }, TAKEOVER_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [attending]);
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
      aria-label="网申现场"
      className={fullscreen
        ? 'fixed inset-0 z-40 flex flex-col bg-[var(--side)]'
        : 'flex h-full min-w-0 flex-1 flex-col border-l border-[var(--line)] bg-[var(--side)]'}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--line)] px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1">
          <div className="font-human text-lg font-semibold text-[var(--ink)]">网申现场</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--muted)]">
            {/* 选中了一份网申时，它等不等他、等什么由标签上的图形和下面的流程说；这里只在他自己操作、或没有网申页面时说浏览器的状态（一个状态只说一次） */}
            {(!shownPage || humanActive) && <>
              <span className={`h-2 w-2 shrink-0 rounded-full ${statusTone}`} aria-hidden="true" />
              <span className="shrink-0">{statusText}</span>
            </>}
            {journeyText(snapshot?.journey) && <span className="shrink-0 rounded bg-[var(--inset)] px-1.5 py-px text-[var(--ink-2)]">{journeyText(snapshot?.journey)}</span>}
            {host && <span className="truncate text-[var(--subtle)]">{host}</span>}
            {stream.status !== 'open' && <span className="ml-2 shrink-0 text-[var(--subtle)]">{stream.status === 'connecting' ? '连接中…' : '重连中'}</span>}
          </div>
        </div>
        {(control === 'agent' || batch?.status === 'running') && (
          <Button variant="ghost" onClick={() => void stop()} className="text-[var(--danger)]">
            <Square className="h-3.5 w-3.5" />停止
          </Button>
        )}
        {snapshot?.journey && (
          // 登录之旅里这一家登不了（只能 QQ / 微信、手边没账号）：先跳过，留在等你里，接着下一家
          <Button variant="ghost" onClick={() => { void apiPostJson<unknown>('/api/career/asks/current/login-journey', { skip: true }).catch((e: unknown) => console.error('[career-live] 跳过这家 FAILED', e)); }}>这家先跳过</Button>
        )}
        {!humanActive && <Button variant="primary" busy={busy === 'take'} disabled={!canTake} onClick={() => void act('take')}>我来操作</Button>}
        {humanActive && <Button variant="primary" busy={busy === 'handback'} disabled={busy !== null} onClick={() => void act('handback')}>交还给小芽</Button>}
        <Button variant="ghost" onClick={() => setWorkSurfaceFullscreen(!fullscreen)} aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏，回到侧栏' : '全屏操作'}>
          {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </Button>
        <Button variant="ghost" onClick={() => collapseWorkSurface('browser')} aria-label="收起浏览器"><X className="h-3.5 w-3.5" /></Button>
      </header>

      <LivePageTabs pages={pages} runs={runs} onShow={showPage} />
      {/* 登录之旅走完后也留着：「X 已登录」要让他看到 */}
      {snapshot?.sms && <SmsCodeBar sms={snapshot.sms} />}

      {/* 画面区域高度不随提示变：画面区域一变，托管浏览器的视口就跟着变，页面会重排、跳动。
          交接提示放在画面下面那一行，不盖住页面（2026-11-03 用户：操作时黄条挡住了页面顶部） */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={frameHostRef} data-testid="live-frame-host" className="min-h-0 flex-1 overflow-auto px-5 py-3">
          <div className="overflow-hidden rounded-lg border border-[var(--line-2)] bg-[var(--paper)] shadow-md">
            <CareerLiveViewport
              frame={frame}
              interactive={humanActive}
              onInputError={setNotice}
              onRequestControl={canTake ? () => act('take') : undefined}
              style={viewportStyle}
              placeholder={frameError ?? (snapshot && !snapshot.browser.hasBrowser ? '浏览器还没有打开' : '等待画面…')}
            />
          </div>
          {chooser && <FileChooserPanel key={chooser.id} chooser={chooser} onDone={msg => { setChooser(null); setInfo(msg); }} />}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            {revealed && <span className="text-[var(--muted)]">页面在真实浏览器窗口里</span>}
            {notice && <span role="alert" className="text-[var(--danger)]">{notice}</span>}
            {!notice && info && <span role="status" className="text-[var(--success)]">{info}</span>}
          </div>
          {/* 要他做什么、走到哪一步只在这一处说（原来画面下一行、面板里各说一遍，还会把别家的话安在这一家头上） */}
          {(snapshot?.browser.hasBrowser || handoff || shownPage) && <TaskProgressPanel page={shownPage} run={shownRun} title={snapshot?.browser.title} batch={batch} takeover={takeover} />}
        </div>
      </div>
    </section>
  );
}
