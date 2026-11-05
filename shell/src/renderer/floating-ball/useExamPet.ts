/**
 * 宠物和它的小面板在笔试里的样子：主窗口点了「开始这场」以后，
 *   - 点宠物 = 框选截一张，挂在宠物身上（角标是挂了几张），不再唤出对话；
 *   - 小面板 = 挂着的截图 + 发出去 + 这场的答案。
 * 状态在侧车（`/exam-search/live`）；主窗口 / 宠物 / 小面板之间靠 fb:exam-changed 互相提醒重新取。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { examSearchApi, type LiveExam } from '@/components/career/exam-search/examSearchApi';
import { EXAM_PET_EVENT, notifyPet } from '@/components/career/exam-search/petBridge';
import { listenWithCleanup } from '@/utils/tauriListen';

const NOT_LIVE: LiveExam = { session: null, shots: [] };

export function useExamLive() {
  const [live, setLive] = useState<LiveExam>(NOT_LIVE);
  const reload = useCallback(() => {
    examSearchApi.live().then(setLive).catch(err => console.warn('[fb-exam] 取开考状态失败', err));
  }, []);
  useEffect(() => {
    reload();
    const ac = new AbortController();
    void listenWithCleanup(EXAM_PET_EVENT, reload, ac.signal);
    return () => ac.abort();
  }, [reload]);
  return { live, reload };
}

/** 宠物：开考时点一下就截图；截的时候再点不重复开框选。 */
export function useExamPet() {
  const { live, reload } = useExamLive();
  const capturing = useRef(false);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setCount(live.shots.length); }, [live.shots.length]);

  const capture = useCallback(async () => {
    if (capturing.current) return;
    capturing.current = true;
    setError(null);
    try {
      const result = await examSearchApi.capture();
      setCount(result.count);
      if (result.captured) notifyPet(['companion']);
    } catch (err) {
      console.warn('[fb-exam] 截图失败', err);
      setError(err instanceof Error ? err.message : String(err));
      reload();
    } finally {
      capturing.current = false;
    }
  }, [reload]);

  return { isLive: live.session !== null, count, error, capture };
}
