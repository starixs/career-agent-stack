// 等待街机：AI 一轮处理超过 HINT_AFTER_SECONDS 秒时，在输入框上方的浮层行
// 冒出「来一把？」提示；点开后是一张小游戏卡片。
//
// 纯前端展示状态，按 Tab 隔离、不持久化（只有用户开关进 config，最高分进
// localStorage）。计时复用 TabState.getQueryElapsedSeconds —— 它在等待用户
// 确认权限 / 回答问题时暂停，所以这些时刻不会去劝用户玩游戏。

import { Gamepad2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfigData } from '@/config/useConfigData';
import { useTabStateOptional } from '@/context/TabContext';

import { ArcadeCanvas, readBestScore } from './ArcadeCanvas';
import { ARCADE_GAME_IDS, type ArcadeGameId } from './games';

export const HINT_AFTER_SECONDS = 20;

const LAST_GAME_KEY = 'career.waitingArcade.lastGame';

function readLastGame(): ArcadeGameId {
  try {
    const saved = localStorage.getItem(LAST_GAME_KEY);
    return (ARCADE_GAME_IDS as readonly string[]).includes(saved ?? '') ? saved as ArcadeGameId : 'snake';
  } catch {
    return 'snake';
  }
}

function writeLastGame(id: ArcadeGameId): void {
  try {
    localStorage.setItem(LAST_GAME_KEY, id);
  } catch {
    // 存储不可用时下次回到默认游戏
  }
}

const CARD_CLASS = 'pointer-events-auto rounded-xl border border-[var(--line)] bg-[var(--paper)]/95 shadow-lg backdrop-blur-md';

const WaitingArcade = memo(function WaitingArcade() {
  const { t } = useTranslation('app');
  const { config } = useConfigData();
  const tab = useTabStateOptional();
  const enabled = config.waitingArcadeEnabled !== false;

  const busy = Boolean(tab && (tab.isLoading || tab.sessionState === 'running' || tab.sessionState === 'starting'));
  const needsUser = Boolean(tab && (
    tab.pendingPermission
    || tab.pendingAskUserQuestion
    || (tab.pendingExitPlanMode && !tab.pendingExitPlanMode.resolved)
  ));
  const getElapsed = tab?.getQueryElapsedSeconds;

  const [open, setOpen] = useState(false);
  const [hintDue, setHintDue] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // 每一轮新的 AI 处理都重新计时、重新允许提示（渲染期派生，不走 effect）
  const [prevBusy, setPrevBusy] = useState(busy);
  if (busy !== prevBusy) {
    setPrevBusy(busy);
    if (busy) {
      setDismissed(false);
      setHintDue(false);
    }
  }

  const watching = enabled && busy && !needsUser && !open && !dismissed && !hintDue && Boolean(getElapsed);
  useEffect(() => {
    if (!watching || !getElapsed) return;
    const check = () => {
      if (getElapsed() >= HINT_AFTER_SECONDS) setHintDue(true);
    };
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [watching, getElapsed]);

  const close = useCallback(() => {
    setOpen(false);
    setDismissed(true);
  }, []);

  if (!enabled) return null;

  if (open) {
    return (
      <ArcadeCard
        busy={busy}
        needsUser={needsUser}
        onClose={close}
      />
    );
  }

  if (!busy || needsUser || dismissed || !hintDue) return null;

  return (
    <div
      role="status"
      data-testid="waiting-arcade-hint"
      className={`${CARD_CLASS} flex items-center gap-2 py-1.5 pl-3 pr-1.5 text-xs text-[var(--ink)]`}
    >
      <Gamepad2 className="size-4 shrink-0 text-[var(--primary)]" aria-hidden />
      <span>{t('waitingArcade.hint')}</span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-[var(--primary)] px-2 py-1 font-medium text-[var(--paper)] transition-opacity hover:opacity-90"
      >
        {t('waitingArcade.play')}
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('waitingArcade.dismiss')}
        title={t('waitingArcade.dismiss')}
        className="rounded-md p-1 text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
});

export default WaitingArcade;

interface ArcadeCardProps {
  busy: boolean;
  needsUser: boolean;
  onClose: () => void;
}

function ArcadeCard({ busy, needsUser, onClose }: ArcadeCardProps) {
  const { t } = useTranslation('app');
  const [gameId, setGameId] = useState<ArcadeGameId>(readLastGame);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(() => readBestScore(gameId));
  // 只有本卡片打开期间「由忙转闲」才算回复好了，避免一打开就弹提醒
  const [replyReady, setReplyReady] = useState(false);
  const [prevBusy, setPrevBusy] = useState(busy);
  if (busy !== prevBusy) {
    setPrevBusy(busy);
    setReplyReady(!busy);
  }

  const notice = needsUser ? t('waitingArcade.needsYou') : replyReady ? t('waitingArcade.replyReady') : null;

  const selectGame = (id: ArcadeGameId) => {
    setGameId(id);
    writeLastGame(id);
    setScore(0);
    setBest(readBestScore(id));
  };

  const onScoreChange = useCallback((nextScore: number, nextBest: number) => {
    setScore(nextScore);
    setBest(nextBest);
  }, []);

  return (
    <section
      aria-label={t('waitingArcade.title')}
      data-testid="waiting-arcade-card"
      className={`${CARD_CLASS} flex w-[314px] flex-col gap-2 p-3`}
    >
      <header className="flex items-center gap-2">
        <div role="tablist" className="flex gap-1">
          {ARCADE_GAME_IDS.map(id => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === gameId}
              onClick={() => selectGame(id)}
              className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                id === gameId
                  ? 'bg-[var(--selected)] font-medium text-[var(--ink)]'
                  : 'text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]'
              }`}
            >
              {t(`waitingArcade.games.${id}`)}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs tabular-nums text-[var(--muted)]">
          {t('waitingArcade.score')} <span className="text-[var(--ink)]">{score}</span>
          {' · '}
          {t('waitingArcade.best')} {best}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('waitingArcade.close')}
          title={t('waitingArcade.close')}
          className="rounded-md p-1 text-[var(--muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <ArcadeCanvas
        key={gameId}
        gameId={gameId}
        autoFocus
        interruptReason={notice}
        onScoreChange={onScoreChange}
        onEscape={onClose}
      />

      {notice ? (
        <div role="status" className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-[var(--primary)]">{notice}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-[var(--primary)] px-2 py-1 font-medium text-[var(--paper)] transition-opacity hover:opacity-90"
          >
            {t('waitingArcade.backToChat')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-[var(--muted)]">{t('waitingArcade.controls')}</p>
      )}
    </section>
  );
}
