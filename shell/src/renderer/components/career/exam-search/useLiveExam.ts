/**
 * 主窗口这边的「开始这场 / 结束这场」：开考后宠物点一下就框选截图，截好的图挂在宠物身上，一口气发出去。
 * 状态在侧车（`/exam-search/live`）；侧车有变化（宠物截了图、发出去了）会广播 data-changed，这里跟着刷新。
 * 开考时宠物没开就顺手打开——点「开始这场」就是要用宠物截图。
 */
import { useCallback, useEffect, useState } from 'react';

import { onEvent } from '@/api/eventBus';
import { runFloatingBallToggleTransaction, setNativeFloatingBallEnabled } from '@/floating-ball/nativeFloatingBall';
import { useConfig } from '@/hooks/useConfig';

import { examSearchApi, type ExamSession, type LiveExam } from './examSearchApi';
import { notifyPet } from './petBridge';

export interface DataChanged { tables?: string[] }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 侧车广播的是不是笔试搜题的变化（没带表名的广播也算）。 */
export const touchesExamSearch = (payload: DataChanged | undefined) => !payload?.tables || payload.tables.includes('exam_search');

export function useLiveExam() {
  const { config, updateConfig } = useConfig();
  const [live, setLive] = useState<LiveExam>({ session: null, shots: [] });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    examSearchApi.live().then(setLive).catch(err => console.warn('[exam-search] 取开考状态失败', err));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => onEvent<DataChanged>('career:data-changed', payload => { if (touchesExamSearch(payload)) reload(); }), [reload]);

  /** 宠物没开就打开；打不开（系统不支持）不挡开考，截图后在页面里 ⌘V 照样能用。 */
  const ensurePet = useCallback(async (): Promise<string | null> => {
    if (config.floatingBallDevGate !== false && config.floatingBallEnabled === true) return null;
    try {
      await runFloatingBallToggleTransaction({
        enabled: true,
        persistDesiredState: enabled => updateConfig({ floatingBallDevGate: true, floatingBallEnabled: enabled }),
        applyNativeState: setNativeFloatingBallEnabled,
      });
      return null;
    } catch (err) {
      console.warn('[exam-search] 打开宠物失败', err);
      return `宠物打不开（${message(err)}），截图后在这里按 ⌘V 也行`;
    }
  }, [config.floatingBallDevGate, config.floatingBallEnabled, updateConfig]);

  const start = useCallback(async (input: { sessionId: string | null; company: string; role: string }): Promise<ExamSession | null> => {
    setError(null);
    try {
      const next = await examSearchApi.startLive({
        session_id: input.sessionId ?? undefined, company_name: input.company.trim() || undefined, role_title: input.role.trim() || undefined,
      });
      setLive(next);
      setError(await ensurePet());
      notifyPet();
      return next.session;
    } catch (err) {
      setError(`开始不了：${message(err)}`);
      return null;
    }
  }, [ensurePet]);

  const end = useCallback(async () => {
    setError(null);
    try {
      await examSearchApi.endLive();
      setLive({ session: null, shots: [] });
      notifyPet();
    } catch (err) {
      setError(`结束不了：${message(err)}`);
    }
  }, []);

  return { live, error, start, end, reload };
}
