// 等待街机：AI 一轮处理超过 HINT_AFTER_SECONDS 秒时，在输入框上方的浮层行
// 冒出「来一把？」提示；点开后从窗口底部掏出一台掌机（HandheldConsole）。
//
// 纯前端展示状态，按 Tab 隔离、不持久化（只有用户开关进 config，最高分 / 静音进
// localStorage）。计时复用 TabState.getQueryElapsedSeconds —— 它在等待用户
// 确认权限 / 回答问题时暂停，所以这些时刻不会去劝用户玩游戏。

import { Gamepad2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfigData } from '@/config/useConfigData';
import { useTabActive, useTabStateOptional } from '@/context/TabContext';

import { HandheldConsole } from './handheld/HandheldConsole';

export const HINT_AFTER_SECONDS = 20;

const CARD_CLASS = 'pointer-events-auto rounded-xl border border-[var(--line)] bg-[var(--paper)]/95 shadow-lg backdrop-blur-md';

const WaitingArcade = memo(function WaitingArcade() {
  const { t } = useTranslation('app');
  const { config } = useConfigData();
  const tab = useTabStateOptional();
  const tabActive = useTabActive();
  const enabled = config.waitingArcadeEnabled !== false;

  const busy = Boolean(tab && (tab.isLoading || tab.sessionState === 'running' || tab.sessionState === 'starting'));
  const needsUser = Boolean(tab && (
    tab.pendingPermission
    || tab.pendingAskUserQuestion
    || (tab.pendingExitPlanMode && !tab.pendingExitPlanMode.resolved)
  ));
  const getElapsed = tab?.getQueryElapsedSeconds;

  /** 掌机打开时记录的水平中心；null 表示收着。 */
  const [openAt, setOpenAt] = useState<{ x: number | null } | null>(null);
  const open = openAt !== null;
  const [hintDue, setHintDue] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // 只有掌机拿在手上期间「由忙转闲」才算回复好了
  const [replyReady, setReplyReady] = useState(false);

  // 每一轮新的 AI 处理都重新计时、重新允许提示（渲染期派生，不走 effect）
  const [prevBusy, setPrevBusy] = useState(busy);
  if (busy !== prevBusy) {
    setPrevBusy(busy);
    if (busy) {
      setDismissed(false);
      setHintDue(false);
      setReplyReady(false);
    } else if (open) {
      setReplyReady(true);
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

  const onClosed = useCallback(() => {
    setOpenAt(null);
    setDismissed(true);
    setReplyReady(false);
  }, []);

  const pullOut = (e: React.MouseEvent<HTMLButtonElement>) => {
    // 掌机对准输入框上方这一行（即聊天栏）的中线
    const row = e.currentTarget.closest('[data-testid="waiting-arcade-hint"]')?.parentElement;
    const rect = row?.getBoundingClientRect();
    setOpenAt({ x: rect && rect.width > 0 ? rect.left + rect.width / 2 : null });
  };

  if (!enabled) return null;

  if (open) {
    if (!tabActive) return null;
    const notice = needsUser ? t('waitingArcade.needsYou') : replyReady ? t('waitingArcade.replyReady') : null;
    return <HandheldConsole anchorX={openAt.x} notice={notice} onClosed={onClosed} />;
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
        onClick={pullOut}
        className="rounded-md bg-[var(--primary)] px-2 py-1 font-medium text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)]"
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
