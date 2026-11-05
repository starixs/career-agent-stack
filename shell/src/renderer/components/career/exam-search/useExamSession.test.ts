import { describe, expect, it } from 'vitest';

import type { ExamSearchRecord } from './examSearchApi';
import { mergeSteps, stepFromRecord, type ExamStep } from './useExamSession';

const record = (id: string, over: Partial<ExamSearchRecord> = {}): ExamSearchRecord => ({
  id, session_id: 's', company_name: null, role_title: null, input_kind: 'image', input_text: null, material: null,
  questions: [{ index: 0, stem: id, options: [], qtype: null, matches: [] }], answers: [], status: 'answered', error: null, answering: false,
  created_at: '', updated_at: '', ...over,
});

describe('一场里的步骤合并', () => {
  it('宠物发出的题正在作答：显示作答中，不算没答完', () => {
    expect(stepFromRecord(record('a', { status: 'recognized', answering: true }))).toMatchObject({ status: 'answering', error: null });
    expect(stepFromRecord(record('a', { status: 'recognized' }))).toMatchObject({ status: 'error', error: '这一步没答完' });
  });

  it('按服务端顺序合并：保留本页的 key 和截图预览、本页正在作答的以本页为准、还没拿到记录的接在后面', () => {
    const local: ExamStep[] = [
      { ...stepFromRecord(record('a'), 'preview-a'), key: 'pending-1' },
      { ...stepFromRecord(record('b', { status: 'recognized' })), key: 'pending-2', status: 'answering', error: null },
      { key: 'pending-3', text: '还在认', preview: null, record: null, status: 'recognizing', error: null },
    ];
    const merged = mergeSteps(local, [record('a'), record('b', { status: 'answered' }), record('c')]);
    expect(merged.map(s => [s.key, s.status])).toEqual([
      ['pending-1', 'done'], ['pending-2', 'answering'], ['c', 'done'], ['pending-3', 'recognizing'],
    ]);
    expect(merged[0].preview).toBe('preview-a');
  });
});
