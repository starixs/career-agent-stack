/**
 * 一场笔试的前端状态：每次粘贴是一步，按先后排成一串，左右箭头前后翻。
 *
 *   粘贴 → 新的一步立刻出现（左栏显示粘进来的东西，右栏「正在认题」）→ 认题（题库原题当场有答案）→ 其余题作答。
 *
 * 几次粘贴可以同时在路上，各自回来各自填进自己那一步，不互相顶掉。
 * 换了一场（新的一场 / 打开记录）以后，上一场还在路上的请求回来只落库，不再改这一场的界面。
 */
import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import { examSearchApi, type ExamSearchRecord, type ExamSession, type ScreenshotInput } from './examSearchApi';

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
  if (record.status === 'recognized' && record.answering) {
    return { key: record.id, text: record.input_text, preview, record, status: 'answering', error: null };
  }
  const unanswered = record.status === 'recognized' && record.questions.length > 0;
  const failed = record.status === 'failed' || unanswered || record.questions.length === 0;
  const error = record.questions.length === 0 ? '没认出题目，换一张更清楚的截图试试' : record.status === 'failed' ? `作答失败：${record.error ?? '原因不明'}` : unanswered ? '这一步没答完' : null;
  return { key: record.id, text: record.input_text, preview, record, status: failed ? 'error' : 'done', error };
}

/** 记录在前（按服务端顺序），本页正在认题、还没拿到记录的步骤接在后面；本页正在作答的步骤以本页为准。 */
export function mergeSteps(local: ExamStep[], records: ExamSearchRecord[]): ExamStep[] {
  const byId = new Map(local.flatMap(step => (step.record ? [[step.record.id, step] as const] : [])));
  const merged = records.map(record => {
    const old = byId.get(record.id);
    if (old?.status === 'answering') return old;
    return { ...stepFromRecord(record, old?.preview ?? null), key: old?.key ?? record.id };
  });
  return [...merged, ...local.filter(step => !step.record)];
}

type SetSteps = Dispatch<SetStateAction<ExamStep[]>>;

/** 这场是谁：场 id（还没建好时等第一次粘贴把场建好）和公司岗位。 */
function useSessionIdentity() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [who, setWho] = useState<Who>({ company: '', role: '' });
  const sessionRef = useRef<string | null>(null);
  /** 这场还没建好时又粘了一次：等第一次把场建好再发，免得一场拆成两场。 */
  const creatingRef = useRef<Promise<string | null> | null>(null);
  const reset = useCallback((id: string | null, next: Who) => {
    sessionRef.current = id;
    creatingRef.current = null;
    setSessionId(id);
    setWho(next);
  }, []);
  const adopt = useCallback((session: ExamSession) => {
    reset(session.id, { company: session.company_name ?? '', role: session.role_title ?? '' });
  }, [reset]);
  return { sessionId, who, setWho, sessionRef, creatingRef, reset, adopt };
}

/** 改一步、给一步作答。epoch 变了（换了一场）就不再改界面。 */
function useStepPatcher(epoch: MutableRefObject<number>, setSteps: SetSteps, onChanged: () => void) {
  /** 拿到记录时，广播先到、已按记录 id 合进来的那份去掉，免得同一步出现两次。 */
  const patch = useCallback((key: string, at: number, next: Partial<ExamStep>) => {
    if (at !== epoch.current) return;
    const recordId = next.record?.id;
    setSteps(list => list
      .filter(step => !recordId || step.key === key || step.record?.id !== recordId)
      .map(step => (step.key === key ? { ...step, ...next } : step)));
  }, [epoch, setSteps]);

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
  return { patch, answer };
}

/** 前后翻：null = 跟着最新的一步；翻过以后是具体下标。 */
function useStepCursor(count: number) {
  const [cursor, setCursor] = useState<number | null>(null);
  const last = count - 1;
  const go = useCallback((delta: number) => {
    setCursor(at => Math.min(Math.max((at ?? last) + delta, 0), last));
  }, [last]);
  const followLatest = useCallback(() => setCursor(null), []);
  return { index: cursor ?? last, go, followLatest };
}

export function useExamSession(onChanged: () => void) {
  const identity = useSessionIdentity();
  const { who, sessionRef, creatingRef, reset, adopt } = identity;
  const [steps, setSteps] = useState<ExamStep[]>([]);
  const { index, go, followLatest } = useStepCursor(steps.length);
  const epoch = useRef(0);
  const tempKey = useRef(0);
  const { patch, answer } = useStepPatcher(epoch, setSteps, onChanged);

  const recognize = useCallback(async (input: PasteInput | 'pet', at: number) => {
    const sessionId = sessionRef.current ?? (creatingRef.current ? await creatingRef.current : null);
    const pending = input === 'pet' ? examSearchApi.sendShots() : examSearchApi.recognize({
      session_id: sessionId ?? undefined, image: input.image, text: input.text,
      company_name: who.company.trim() || undefined, role_title: who.role.trim() || undefined,
    });
    if (!sessionId) creatingRef.current = pending.then(r => r.session.id, () => null);
    const result = await pending;
    if (at === epoch.current) adopt(result.session);
    return result;
  }, [adopt, creatingRef, sessionRef, who]);

  /** 新的一步：粘贴的文字 / 截图，或者把宠物身上挂着的截图一口气发出去（'pet'，preview 用第一张缩略图）。 */
  const launch = useCallback((input: PasteInput | 'pet', preview: string | null): Promise<void> => {
    const at = epoch.current;
    const key = `pending-${++tempKey.current}`;
    const text = input === 'pet' ? null : input.text ?? null;
    setSteps(list => [...list, { key, text, preview, record: null, status: 'recognizing', error: null }]);
    followLatest();
    return recognize(input, at).then(({ search }) => {
      patch(key, at, { ...stepFromRecord(search, preview), key });
      if (at === epoch.current && search.status === 'recognized' && search.questions.length > 0) void answer(key, search.id, at);
      else onChanged();
    }).catch(err => patch(key, at, { status: 'error', error: `认题失败：${message(err)}` }));
  }, [answer, followLatest, onChanged, patch, recognize]);

  const paste = useCallback((input: PasteInput) => { void launch(input, input.preview ?? null); }, [launch]);
  const sendPetShots = useCallback((firstThumb: string | null) => launch('pet', firstThumb), [launch]);
  const retry = useCallback((step: ExamStep) => {
    if (step.record && step.record.questions.length > 0) void answer(step.key, step.record.id, epoch.current);
  }, [answer]);

  /** 换一场：新的一场（who 给定）或打开记录里的某场（带上它的每一步）。 */
  const switchTo = useCallback((next: { id: string | null; who: Who; steps: ExamStep[] }) => {
    epoch.current++;
    reset(next.id, next.who);
    setSteps(next.steps);
    followLatest();
  }, [followLatest, reset]);

  /** 服务端这场的记录更新了（比如宠物发出去的题）：按记录 id 合并，本页还在路上的步骤留着。 */
  const sync = useCallback((id: string, records: ExamSearchRecord[]) => {
    if (id === sessionRef.current) setSteps(list => mergeSteps(list, records));
  }, [sessionRef]);

  return {
    sessionId: identity.sessionId, who, setWho: identity.setWho, steps, index, current: steps[index] ?? null,
    paste, sendPetShots, retry, switchTo, sync, go,
  };
}

export type ExamSessionState = ReturnType<typeof useExamSession>;
