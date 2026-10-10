// 单个游戏的画布宿主：rAF 循环、键盘焦点、暂停与主题配色。
//
// 键盘只在画布获得焦点时生效，并在画布上 stopPropagation，避免方向键 / 空格
// 冒泡到 window 上的聊天滚动监听（useVirtuosoScroll）或抢走输入框按键。
// 失焦即暂停：用户点回输入框打字时游戏自动停下。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  ARCADE_HEIGHT,
  ARCADE_WIDTH,
  createArcadeGame,
  keyToArcadeAction,
  type ArcadeAction,
  type ArcadeGameId,
  type ArcadePalette,
} from './games';

/** 切后台 / 卡顿回来时最多推进 50ms，避免一帧里穿墙或连死。 */
const MAX_FRAME_MS = 50;

const PALETTE_VARS: Record<keyof ArcadePalette, string> = {
  bg: '--inset',
  ink: '--ink',
  muted: '--muted',
  line: '--line-2',
  primary: '--primary',
  accent: '--seal',
  danger: '--danger',
};

const FALLBACK_PALETTE: ArcadePalette = {
  bg: '#f4f1ea', ink: '#1f1d1a', muted: '#8a857c', line: '#d8d2c6',
  primary: '#3f6b5c', accent: '#c4553a', danger: '#b4412f',
};

function readPalette(el: Element): ArcadePalette {
  const style = getComputedStyle(el);
  const out = { ...FALLBACK_PALETTE };
  for (const key of Object.keys(PALETTE_VARS) as (keyof ArcadePalette)[]) {
    const value = style.getPropertyValue(PALETTE_VARS[key]).trim();
    if (value) out[key] = value;
  }
  return out;
}

const BEST_KEY_PREFIX = 'career.waitingArcade.best.';

export function readBestScore(id: ArcadeGameId): number {
  try {
    return Number(localStorage.getItem(BEST_KEY_PREFIX + id)) || 0;
  } catch {
    return 0;
  }
}

function writeBestScore(id: ArcadeGameId, score: number): void {
  try {
    localStorage.setItem(BEST_KEY_PREFIX + id, String(score));
  } catch {
    // 隐私模式等场景下存储不可用，最高分只在本次会话内有效
  }
}

type Phase = 'idle' | 'playing' | 'paused' | 'over';

interface ArcadeCanvasProps {
  gameId: ArcadeGameId;
  /** 外部要求暂停的原因（如 AI 回复好了）；变为非空时暂停一次。 */
  interruptReason?: string | null;
  autoFocus?: boolean;
  onScoreChange?: (score: number, best: number) => void;
  onEscape?: () => void;
}

export function ArcadeCanvas({ gameId, interruptReason, autoFocus, onScoreChange, onEscape }: ArcadeCanvasProps) {
  const { t } = useTranslation('app');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game] = useState(() => createArcadeGame(gameId));
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const paletteRef = useRef<ArcadePalette>(FALLBACK_PALETTE);
  const bestRef = useRef(readBestScore(gameId));
  const lastScoreRef = useRef(-1);
  const heldRef = useRef(new Set<ArcadeAction>());

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // 外部中断（如 AI 回复好了）在渲染期派生为暂停
  const [prevInterrupt, setPrevInterrupt] = useState(interruptReason);
  if (interruptReason !== prevInterrupt) {
    setPrevInterrupt(interruptReason);
    if (interruptReason && phase === 'playing') setPhase('paused');
  }

  const releaseHeld = useCallback(() => {
    for (const action of heldRef.current) game.key(action, false);
    heldRef.current.clear();
  }, [game]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== ARCADE_WIDTH * dpr) {
      canvas.width = ARCADE_WIDTH * dpr;
      canvas.height = ARCADE_HEIGHT * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    game.draw(ctx, paletteRef.current);
  }, [game]);

  const reportScore = useCallback(() => {
    if (game.score === lastScoreRef.current) return;
    lastScoreRef.current = game.score;
    if (game.score > bestRef.current) {
      bestRef.current = game.score;
      writeBestScore(gameId, game.score);
    }
    onScoreChange?.(game.score, bestRef.current);
  }, [game, gameId, onScoreChange]);

  // 主题：初次读取，并在 <html> 的 class / data-color-scheme 变化时刷新
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paletteRef.current = readPalette(canvas);
    draw();
    reportScore();
    const observer = new MutationObserver(() => {
      paletteRef.current = readPalette(canvas);
      draw();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-color-scheme', 'data-theme-id', 'style'],
    });
    return () => observer.disconnect();
  }, [draw, reportScore]);

  // 游戏循环只在 playing 时运行；其他阶段画面静止，不耗电
  useEffect(() => {
    if (phase !== 'playing') return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(MAX_FRAME_MS, now - last);
      last = now;
      game.step(dt);
      draw();
      reportScore();
      if (game.over) {
        setPhase('over');
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // 离开 playing（暂停 / 结束 / 卸载）时松开所有按住的键，回来不会自己跑
    return () => {
      cancelAnimationFrame(raf);
      releaseHeld();
    };
  }, [phase, game, draw, reportScore, releaseHeld]);

  useEffect(() => {
    if (autoFocus) canvasRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const restart = useCallback(() => {
    game.reset();
    lastScoreRef.current = -1;
    draw();
    reportScore();
    setPhase('playing');
  }, [game, draw, reportScore]);

  const activate = useCallback(() => {
    const current = phaseRef.current;
    if (current === 'over') restart();
    else if (current !== 'playing') setPhase('playing');
  }, [restart]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    // 带修饰键的组合（⌘W、⌘T…）交还给应用快捷键
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onEscape?.();
      return;
    }
    if (e.code === 'KeyP') {
      e.preventDefault();
      e.stopPropagation();
      if (phaseRef.current === 'playing') {
        setPhase('paused');
      } else {
        activate();
      }
      return;
    }
    const action = keyToArcadeAction(e.code);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (phaseRef.current !== 'playing') {
      if (!e.repeat) activate();
      return;
    }
    if (e.repeat && heldRef.current.has(action)) return;
    heldRef.current.add(action);
    game.key(action, true);
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const action = keyToArcadeAction(e.code);
    if (!action) return;
    e.stopPropagation();
    heldRef.current.delete(action);
    game.key(action, false);
  };

  const onBlur = () => {
    if (phaseRef.current === 'playing') setPhase('paused');
  };

  const overlay = interruptReason && phase !== 'playing'
    ? interruptReason
    : phase === 'idle'
      ? t('waitingArcade.focusToPlay')
      : phase === 'paused'
        ? t('waitingArcade.paused')
        : phase === 'over'
          ? t('waitingArcade.gameOver')
          : null;

  return (
    <div className="relative overflow-hidden rounded-lg border border-[var(--line)]">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label={t(`waitingArcade.games.${gameId}`)}
        data-testid="waiting-arcade-canvas"
        data-phase={phase}
        style={{ width: ARCADE_WIDTH, height: ARCADE_HEIGHT }}
        className="block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
        onClick={activate}
      />
      {overlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[var(--paper)]/70 px-4 text-center text-xs font-medium text-[var(--ink)]">
          {overlay}
        </div>
      )}
    </div>
  );
}
