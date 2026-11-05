/**
 * 一场笔试的前端状态：每次粘贴是一步，按先后排成一串，左右箭头前后翻。
 *
 *   粘贴 → 新的一步立刻出现（左栏显示粘进来的东西，右栏「正在认题」）→ 认题（题库原题当场有答案）→ 其余题作答。
 *
 * 几次粘贴可以同时在路上，各自回来各自填进自己那一步，不互相顶掉。
 * 换了一场（新的一场 / 打开记录）以后，上一场还在路上的请求回来只落库，不再改这一场的界面。
 */
import { useCallback, useRef, useState } from 'react';

import { examSearchApi, type ExamSearchRecord, type ScreenshotInput } from './examSearchApi';

export type StepStatus = 'recognizing' | 'answering' | 'done' | 'error';

export interface ExamStep {
  key: string;
  text: string | null;
  /** 认题期间先显示的截图；认完左栏改按认出的题排版，记录里不存图。 */
  preview: string | null;
  record: ExamSearchRecord | null;
  status: StepStatus;
  error: string | null;
}

export interface Who { company: string; role: string }
export interface PasteInput { text?: string; image?: ScreenshotInput; preview?: string }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 记录里的一步：认完题但没答完（比如中途关了页面）算出错，给重试。 */
export function stepFromRecord(record: ExamSearchRecord, preview: string | null = null): ExamStep {
  const unanswered = record.status === 'recognized' && record.questions.length > 0;
  const failed = record.status === 'failed' || unanswered || record.questions.length === 0;
  const error = record.questions.length === 0 ? '没认出题目，换一张更清楚的截图试试' : record.status === 'failed' ? `作答失败：${record.error ?? '原因不明'}` : unanswered ? '这一步没答完' : null;
  return { key: record.id, text: record.input_text, preview, record, status: failed ? 'error' : 'done', error };
}

export function useExamSession(onChanged: () => void) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [who, setWho] = useState<Who>({ company: '', role: '' });
  const [steps, setSteps] = useState<ExamStep[]>([]);
  /** null = 跟着最新的一步；前后翻过以后是具体下标。 */
  const [cursor, setCursor] = useState<number | null>(null);
  const epoch = useRef(0);
  const sessionRef = useRef<string | null>(null);
  /** 这场还没建好时又粘了一次：等第一次把场建好再发，免得一场拆成两场。 */
  const creating = useRef<Promise<string | null> | null>(null);
  const tempKey = useRef(0);

  const patch = useCallback((key: string, at: number, next: Partial<ExamStep>) => {
    if (at !== epoch.current) return;
    setSteps(list => list.map(step => (step.key === key ? { ...step, ...next } : step)));
  }, []);

  const answer = useCallback(async (key: string, id: string, at: number) => {
    patch(key, at, { status: 'answering', error: null });
    try {
      const record = await examSearchApi.answer(id);
      patch(key, at, { record, status: 'done' });
    } catch (err) {
      patch(key, at, { status: 'error', error: `作答失败：${message(err)}` });
    } finally {
      onChanged();
    }
  }, [onChanged, patch]);

  const recognize = useCallback(async (input: PasteInput, at: number) => {
    const sessionId = sessionRef.current ?? (creating.current ? await creating.current : null);
    const pending = examSearchApi.recognize({
      session_id: sessionId ?? undefined, image: input.image, text: input.text,
      company_name: who.company.trim() || undefined, role_title: who.role.trim() || undefined,
    });
    if (!sessionId) creating.current = pending.then(r => r.session.id, () => null);
    const result = await pending;
    if (at === epoch.current) {
      sessionRef.current = result.session.id;
      setSessionId(result.session.id);
      setWho({ company: result.session.company_name ?? '', role: result.session.role_title ?? '' });
    }
    return result;
  }, [who]);

  const paste = useCallback((input: PasteInput) => {
    const at = epoch.current;
    const key = `pending-${++tempKey.current}`;
    setSteps(list => [...list, { key, text: input.text ?? null, preview: input.preview ?? null, record: null, status: 'recognizing', error: null }]);
    setCursor(null);
    recognize(input, at).then(({ search }) => {
      patch(key, at, { ...stepFromRecord(search, input.preview ?? null), key });
      if (at === epoch.current && search.status === 'recognized' && search.questions.length > 0) void answer(key, search.id, at);
      else onChanged();
    }).catch(err => patch(key, at, { status: 'error', error: `认题失败：${message(err)}` }));
  }, [answer, onChanged, patch, recognize]);

  const retry = useCallback((step: ExamStep) => {
    if (step.record && step.record.questions.length > 0) void answer(step.key, step.record.id, epoch.current);
  }, [answer]);

  /** 换一场：新的一场（who 给定）或打开记录里的某场（带上它的每一步）。 */
  const switchTo = useCallback((next: { id: string | null; who: Who; steps: ExamStep[] }) => {
    epoch.current++;
    sessionRef.current = next.id;
    creating.current = null;
    setSessionId(next.id);
    setWho(next.who);
    setSteps(next.steps);
    setCursor(null);
  }, []);

  const last = steps.length - 1;
  const index = cursor ?? last;
  const go = useCallback((delta: number) => {
    setCursor(at => Math.min(Math.max((at ?? last) + delta, 0), last));
  }, [last]);

  return { sessionId, who, setWho, steps, index, current: steps[index] ?? null, paste, retry, switchTo, go };
}

export type ExamSessionState = ReturnType<typeof useExamSession>;
