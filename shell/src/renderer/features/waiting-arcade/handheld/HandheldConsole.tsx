// 拟真横版掌机：从窗口底部「掏出来」，键盘 / 鼠标按下时对应实体按键实时下沉，
// 伴随塑料按键的咔哒声。屏幕逻辑在 HandheldScreen，本组件只负责外壳、输入与渲染循环。
//
// 键盘只在掌机获得焦点时生效，并在掌机上 stopPropagation：方向键 / 空格不会冒泡到
// window 上的聊天滚动监听（useVirtuosoScroll），也不会进输入框。失焦即暂停。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { ARCADE_GAME_IDS, ARCADE_HEIGHT, ARCADE_WIDTH, type ArcadeGameId } from '../games';
import './handheld.css';
import { isDpad, keyToButton } from './keys';
import { HandheldScreen, type HandheldButton, type ScreenText } from './screen';
import { HandheldSound } from './sound';

/** 外壳的设计尺寸；舞台按窗口大小整体缩放。 */
const STAGE_W = 600;
const STAGE_H = 400;
/** 窗口够大时把掌机放大到这个倍数：机身要大，屏幕保持小巧。 */
const MAX_SCALE = 1.4;
/** 收起动画时长，与 handheld.css 的 hh-put-away 一致；动画事件丢失时兜底。 */
const PUT_AWAY_MS = 420;
const MAX_FRAME_MS = 50;

const BEST_KEY = 'career.waitingArcade.best.';
const LAST_GAME_KEY = 'career.waitingArcade.lastGame';
const MUTED_KEY = 'career.waitingArcade.muted';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存储不可用（隐私模式等）时只在本次会话内生效
  }
}

const bestStore = {
  read: (id: ArcadeGameId) => Number(readStorage(BEST_KEY + id)) || 0,
  write: (id: ArcadeGameId, score: number) => writeStorage(BEST_KEY + id, String(score)),
};

function readLastGame(): ArcadeGameId {
  const saved = readStorage(LAST_GAME_KEY);
  return (ARCADE_GAME_IDS as readonly string[]).includes(saved ?? '') ? saved as ArcadeGameId : 'snake';
}

function subscribeViewport(onChange: () => void) {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}
const viewportSnapshot = () => `${window.innerWidth}x${window.innerHeight}`;

interface HandheldConsoleProps {
  /** 掌机水平中心（视口坐标），取自输入框上方浮层行，让掌机对准聊天栏。 */
  anchorX: number | null;
  /** 需要用户回到对话的原因（AI 回复好了 / 在等你确认）；出现时游戏暂停并提醒。 */
  notice: string | null;
  onClosed: () => void;
}

export function HandheldConsole({ anchorX, notice, onClosed }: HandheldConsoleProps) {
  const { t } = useTranslation('app');
  const deviceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [closing, setClosing] = useState(false);
  const [pressed, setPressed] = useState<ReadonlySet<HandheldButton>>(() => new Set());
  const [muted, setMuted] = useState(() => readStorage(MUTED_KEY) === '1');
  const [sound] = useState(() => new HandheldSound(readStorage(MUTED_KEY) === '1'));
  const [screen] = useState(() => {
    const text: ScreenText = {
      wordmark: 'POCKET',
      menuTitle: t('waitingArcade.lcd.menuTitle'),
      menuHint: t('waitingArcade.lcd.menuHint'),
      best: t('waitingArcade.lcd.best'),
      paused: t('waitingArcade.lcd.paused'),
      pausedHint: t('waitingArcade.lcd.pausedHint'),
      gameOver: t('waitingArcade.lcd.gameOver'),
      overHint: t('waitingArcade.lcd.overHint'),
      games: {
        snake: t('waitingArcade.games.snake'),
        breakout: t('waitingArcade.games.breakout'),
        runner: t('waitingArcade.games.runner'),
      },
    };
    return new HandheldScreen({
      text,
      best: bestStore,
      initialGame: readLastGame(),
      onSound: s => sound.play(s),
      onGameChange: id => writeStorage(LAST_GAME_KEY, id),
    });
  });

  // ─── 渲染循环：只在开机动画 / 游戏中逐帧推进，其余时间按需重绘 ───
  const rafRef = useRef(0);
  const draw = useCallback(() => {
    // 屏幕状态在 React 之外推进（rAF），直接写到 DOM 上供样式与测试读取
    if (deviceRef.current) deviceRef.current.dataset.mode = screen.mode;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== ARCADE_WIDTH * dpr) {
      canvas.width = ARCADE_WIDTH * dpr;
      canvas.height = ARCADE_HEIGHT * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    screen.draw(ctx);
  }, [screen]);

  const kick = useCallback(() => {
    draw();
    if (rafRef.current || !screen.animating) return;
    let last = performance.now();
    const frame = (now: number) => {
      screen.step(Math.min(MAX_FRAME_MS, now - last));
      last = now;
      draw();
      rafRef.current = screen.animating ? requestAnimationFrame(frame) : 0;
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [draw, screen]);

  useEffect(() => {
    kick();
    deviceRef.current?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      sound.dispose();
    };
  }, [kick, sound]);

  useEffect(() => {
    if (!notice) return;
    screen.pause(notice);
    kick();
  }, [notice, screen, kick]);

  // ─── 输入 ───
  const down = useCallback((button: HandheldButton) => {
    setPressed(prev => (prev.has(button) ? prev : new Set(prev).add(button)));
    sound.click(true);
    screen.press(button);
    kick();
  }, [screen, sound, kick]);

  const up = useCallback((button: HandheldButton) => {
    setPressed(prev => {
      if (!prev.has(button)) return prev;
      const next = new Set(prev);
      next.delete(button);
      return next;
    });
    sound.click(false);
    screen.release(button);
    kick();
  }, [screen, sound, kick]);

  const close = useCallback(() => {
    setClosing(true);
    screen.pause();
  }, [screen]);

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onClosed, PUT_AWAY_MS + 80);
    return () => clearTimeout(timer);
  }, [closing, onClosed]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 带修饰键的组合（⌘W、⌘T…）交还给应用快捷键
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const button = keyToButton(e.code);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || pressed.has(button)) return;
    down(button);
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    const button = keyToButton(e.code);
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();
    up(button);
  };

  const onBlur = () => {
    for (const button of pressed) up(button);
    screen.pause();
    kick();
  };

  const toggleMute = () => {
    const next = !muted;
    sound.setMuted(next);
    setMuted(next);
    writeStorage(MUTED_KEY, next ? '1' : '0');
    if (!next) sound.play('move');
  };

  /** 鼠标按实体按键：按下时阻止默认行为，焦点留在掌机上。 */
  const press = (button: HandheldButton) => ({
    'data-pressed': pressed.has(button) || undefined,
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      deviceRef.current?.focus({ preventScroll: true });
      down(button);
    },
    onPointerUp: () => up(button),
    onPointerCancel: () => up(button),
  });

  // ─── 布局：对准聊天栏中线，按窗口大小等比缩放 ───
  const viewport = useSyncExternalStore(subscribeViewport, viewportSnapshot, viewportSnapshot);
  const [vw, vh] = viewport.split('x').map(Number);
  const scale = Math.min(MAX_SCALE, (vw - 24) / STAGE_W, (vh - 24) / STAGE_H);
  const half = (STAGE_W * scale) / 2;
  const centerX = Math.min(vw - half - 12, Math.max(half + 12, anchorX ?? vw / 2));

  const dpadDir = (['up', 'down', 'left', 'right'] as const).filter(b => pressed.has(b));
  const nudge = [...pressed].some(b => isDpad(b) || b === 'start' || b === 'select' || b === 'l')
    ? 'left'
    : pressed.size > 0 ? 'right' : undefined;

  const keyHints: [string, string][] = [
    ['↑↓←→', t('waitingArcade.keys.move')],
    ['X', 'A'],
    ['Z', 'B'],
    ['Enter', 'START'],
    ['Shift', 'SELECT'],
    ['Esc', t('waitingArcade.keys.putAway')],
  ];

  return createPortal(
    <div
      className="hh-stage"
      data-stage={closing ? 'closing' : 'open'}
      style={{ left: centerX - STAGE_W / 2, width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
    >
      <div
        className="hh-rig"
        onAnimationEnd={e => {
          if (closing && e.animationName === 'hh-put-away') onClosed();
        }}
      >
        {notice && (
          <div className="hh-bubble" role="status">
            <span>{notice}</span>
            <button type="button" onClick={close}>{t('waitingArcade.backToChat')}</button>
          </div>
        )}

        <div
          ref={deviceRef}
          className="hh-device"
          role="application"
          aria-label={t('waitingArcade.handheld')}
          aria-roledescription={t('waitingArcade.handheld')}
          tabIndex={0}
          data-testid="waiting-arcade-handheld"
          data-nudge={nudge}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={onBlur}
        >
          <div className="hh-shoulder hh-shoulder-l" {...press('l')}><span>L</span></div>
          <div className="hh-shoulder hh-shoulder-r" {...press('r')}><span>R</span></div>

          <svg className="hh-shell" viewBox="0 0 600 316" aria-hidden>
            <defs>
              <linearGradient id="hh-body-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#7a6de0" />
                <stop offset="0.35" stopColor="#5d4ec4" />
                <stop offset="1" stopColor="#3e3197" />
              </linearGradient>
              <radialGradient id="hh-body-sheen" cx="0.3" cy="0.05" r="0.75">
                <stop offset="0" stopColor="#ffffff" stopOpacity="0.28" />
                <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.04" />
                <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
              </radialGradient>
              <filter id="hh-bevel" x="-5%" y="-5%" width="110%" height="110%">
                <feFlood floodColor="#160e4a" floodOpacity="0.6" result="shadeColor" />
                <feComposite in="shadeColor" in2="SourceAlpha" operator="out" result="outside" />
                <feGaussianBlur in="outside" stdDeviation="7" result="blurred" />
                <feOffset in="blurred" dy="-6" result="lifted" />
                <feComposite in="lifted" in2="SourceAlpha" operator="in" result="innerShade" />
                <feFlood floodColor="#ffffff" floodOpacity="0.45" result="lightColor" />
                <feComposite in="lightColor" in2="SourceAlpha" operator="out" result="outsideLight" />
                <feGaussianBlur in="outsideLight" stdDeviation="2" result="blurLight" />
                <feOffset in="blurLight" dy="2.5" result="droppedLight" />
                <feComposite in="droppedLight" in2="SourceAlpha" operator="in" result="innerLight" />
                <feMerge>
                  <feMergeNode in="SourceGraphic" />
                  <feMergeNode in="innerShade" />
                  <feMergeNode in="innerLight" />
                </feMerge>
              </filter>
            </defs>
            <path className="hh-body" d={BODY_PATH} fill="url(#hh-body-fill)" filter="url(#hh-bevel)" />
            <path d={BODY_PATH} fill="url(#hh-body-sheen)" />
            {/* 正面一圈分模线 */}
            <path d={BODY_PATH} fill="none" stroke="#2c2275" strokeOpacity="0.35" strokeWidth="1" transform="translate(12 10) scale(0.96 0.94)" />
          </svg>

          <div className="hh-lens">
            <div className="hh-led" data-on="true" data-alert={notice ? 'true' : undefined} />
            <span className="hh-led-label">POWER</span>
            <div className="hh-lcd">
              <canvas
                ref={canvasRef}
                data-testid="waiting-arcade-canvas"
                style={{ width: ARCADE_WIDTH, height: ARCADE_HEIGHT }}
              />
            </div>
            <div className="hh-wordmark">
              <b>POCKET BOY</b> <i>ADVANCE</i>
            </div>
          </div>

          <div className="hh-dpad-well">
            <div
              className="hh-dpad"
              data-dir={dpadDir.join(' ') || undefined}
              style={{ transform: dpadTilt(dpadDir) }}
            >
              <div className="hh-dpad-v" />
              <div className="hh-dpad-h" />
              <div className="hh-dpad-dimple" />
              {(['up', 'down', 'left', 'right'] as const).map(dir => (
                <div key={dir} className={`hh-dpad-hit hh-dpad-${dir}`} {...press(dir)}>
                  <i />
                </div>
              ))}
            </div>
          </div>

          <div className="hh-meta hh-start">
            <div className="hh-meta-well"><div className="hh-meta-btn" {...press('start')} /></div>
            <span>START</span>
          </div>
          <div className="hh-meta hh-select">
            <div className="hh-meta-well"><div className="hh-meta-btn" {...press('select')} /></div>
            <span>SELECT</span>
          </div>

          <div className="hh-ab-well" />
          <div className="hh-ab hh-a" {...press('a')} />
          <div className="hh-ab hh-b" {...press('b')} />
          <span className="hh-ab-label hh-a-label">A</span>
          <span className="hh-ab-label hh-b-label">B</span>

          <div className="hh-speaker" aria-hidden>
            {Array.from({ length: 6 }, (_, i) => <i key={i} />)}
          </div>

          <button
            type="button"
            tabIndex={-1}
            className="hh-power"
            aria-label={t('waitingArcade.keys.putAway')}
            title={t('waitingArcade.keys.putAway')}
            onPointerDown={e => e.preventDefault()}
            onClick={close}
          >
            <span>OFF</span><i /><span>ON</span>
          </button>
          <button
            type="button"
            tabIndex={-1}
            className="hh-volume"
            data-muted={muted || undefined}
            aria-label={muted ? t('waitingArcade.unmute') : t('waitingArcade.mute')}
            title={muted ? t('waitingArcade.unmute') : t('waitingArcade.mute')}
            onPointerDown={e => e.preventDefault()}
            onClick={toggleMute}
          >
            <i /><span>VOL</span>
          </button>
        </div>

        <div className="hh-hints" aria-hidden>
          {keyHints.map(([keys, label]) => (
            <span key={label}><kbd>{keys}</kbd>{label}</span>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 方向键是一整块十字，按哪边就朝哪边倾斜下沉，和实体十字键一样。 */
function dpadTilt(dirs: readonly HandheldButton[]): string {
  const x = (dirs.includes('up') ? 1 : 0) - (dirs.includes('down') ? 1 : 0);
  const y = (dirs.includes('right') ? 1 : 0) - (dirs.includes('left') ? 1 : 0);
  if (x === 0 && y === 0) return 'none';
  return `perspective(260px) rotateX(${x * 12}deg) rotateY(${y * 12}deg) translateZ(-3px)`;
}

const BODY_PATH = [
  'M150 18 L450 18',
  'C470 18 482 4 515 4',
  'C575 4 600 62 600 150',
  'C600 252 562 312 494 312',
  'C462 312 450 299 420 299',
  'L180 299',
  'C150 299 138 312 106 312',
  'C38 312 0 252 0 150',
  'C0 62 25 4 85 4',
  'C118 4 130 18 150 18 Z',
].join(' ');
