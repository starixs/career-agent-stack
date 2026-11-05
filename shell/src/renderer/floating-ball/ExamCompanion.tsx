/**
 * 开考时宠物的小面板：挂着的截图（可去掉某张）→ 发出去 → 这场的答案，左右翻看每一次。
 * 和主窗口共用同一场的记录：主窗口粘的、这里发的，都在同一串里。
 */
import { useEffect, useState } from 'react';

import { examSearchApi, type LiveExam } from '@/components/career/exam-search/examSearchApi';
import { AnswerPane, StepArrows } from '@/components/career/exam-search/ExamSteps';
import { EXAM_PET_EVENT, notifyPet } from '@/components/career/exam-search/petBridge';
import { ShotTray } from '@/components/career/exam-search/ShotTray';
import { stepFromRecord, useExamSession } from '@/components/career/exam-search/useExamSession';
import { listenWithCleanup } from '@/utils/tauriListen';

/** 这场的每一步：开考的场换了就整串换；别处有变化（主窗口粘了题、答完了）就按记录合并。 */
function useLiveSteps(sessionId: string) {
  const exam = useExamSession(() => notifyPet(['ball']));
  const { switchTo, sync } = exam;
  useEffect(() => {
    examSearchApi.session(sessionId)
      .then(({ session, searches }) => switchTo({
        id: session.id, who: { company: session.company_name ?? '', role: session.role_title ?? '' }, steps: searches.map(r => stepFromRecord(r)),
      }))
      .catch(err => console.warn(`[fb-exam] 取这场 ${sessionId} 失败`, err));
    const ac = new AbortController();
    void listenWithCleanup(EXAM_PET_EVENT, () => {
      examSearchApi.session(sessionId).then(({ searches }) => sync(sessionId, searches))
        .catch(err => console.warn(`[fb-exam] 同步这场 ${sessionId} 失败`, err));
    }, ac.signal);
    return () => ac.abort();
  }, [sessionId, switchTo, sync]);
  return exam;
}

export function ExamCompanion({ live, onChanged }: { live: LiveExam & { session: NonNullable<LiveExam['session']> }; onChanged: () => void }) {
  const exam = useLiveSteps(live.session.id);
  const [busy, setBusy] = useState(false);
  const title = [live.session.company_name, live.session.role_title].filter(Boolean).join(' · ') || '这场笔试';

  const send = () => {
    setBusy(true);
    void exam.sendPetShots(live.shots[0]?.thumb ?? null).finally(() => { setBusy(false); onChanged(); notifyPet(['ball']); });
  };
  const remove = (id: string) => {
    examSearchApi.removeShot(id)
      .then(() => { onChanged(); notifyPet(['ball']); })
      .catch(err => console.warn(`[fb-exam] 去掉截图 ${id} 失败`, err));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2">
      <div className="text-sm font-semibold text-[var(--ink)]">{title} · 正在考</div>
      <ShotTray shots={live.shots} busy={busy} onRemove={shot => remove(shot.id)} onSend={send} />
      {exam.steps.length > 0 && (
        <div className="space-y-1 border-t border-[var(--line)] pt-2">
          <StepArrows row index={exam.index} total={exam.steps.length} onGo={exam.go} />
          <AnswerPane compact step={exam.current} onRetry={exam.retry} />
        </div>
      )}
    </div>
  );
}
