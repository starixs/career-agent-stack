/**
 * 一次搜题的状态：识别（题目 + 题库原题当场出答案）→ 作答（其余题交给模型）。
 * 新的一次粘贴会顶掉正在进行的这次：旧请求回来时按代数丢弃，不覆盖新结果。
 */
import { useCallback, useRef, useState } from 'react';

import { examSearchApi, type ExamSearchRecord, type ScreenshotInput } from './examSearchApi';

export type SearchPhase = 'idle' | 'recognizing' | 'answering' | 'done' | 'error';

export interface SearchInput { image?: ScreenshotInput; text?: string; companyName: string; roleTitle: string }

export interface ExamSearchState {
  record: ExamSearchRecord | null;
  phase: SearchPhase;
  error: string | null;
  run: (input: SearchInput) => void;
  retryAnswer: () => void;
  show: (record: ExamSearchRecord) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useExamSearch(onChanged: () => void): ExamSearchState {
  const [record, setRecord] = useState<ExamSearchRecord | null>(null);
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const answer = useCallback(async (id: string, gen: number) => {
    setPhase('answering');
    try {
      const answered = await examSearchApi.answer(id);
      if (gen !== generation.current) return;
      setRecord(answered);
      setPhase('done');
    } catch (err) {
      if (gen !== generation.current) return;
      setError(`作答失败：${message(err)}`);
      setPhase('error');
    } finally {
      onChanged();
    }
  }, [onChanged]);

  const run = useCallback((input: SearchInput) => {
    const gen = ++generation.current;
    setPhase('recognizing');
    setError(null);
    setRecord(null);
    examSearchApi.recognize({
      image: input.image, text: input.text,
      company_name: input.companyName.trim() || undefined, role_title: input.roleTitle.trim() || undefined,
    }).then(recognized => {
      if (gen !== generation.current) return;
      setRecord(recognized);
      if (recognized.questions.length === 0) { setError('没认出题目，换一张更清楚的截图试试'); setPhase('error'); return; }
      if (recognized.status === 'answered') { setPhase('done'); onChanged(); return; }
      void answer(recognized.id, gen);
    }).catch(err => {
      if (gen !== generation.current) return;
      setError(`识别失败：${message(err)}`);
      setPhase('error');
    });
  }, [answer, onChanged]);

  const retryAnswer = useCallback(() => {
    if (!record) return;
    setError(null);
    void answer(record.id, ++generation.current);
  }, [answer, record]);

  const show = useCallback((next: ExamSearchRecord) => {
    generation.current++;
    setRecord(next);
    setError(next.status === 'failed' ? next.error : null);
    setPhase(next.status === 'failed' ? 'error' : 'done');
  }, []);

  return { record, phase, error, run, retryAnswer, show };
}
