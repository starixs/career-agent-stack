/**
 * 搜题流程：识别 → 检索 → 作答，分两次请求，好让界面先看到题目和题库原题，再等模型作答。
 *
 *   recognize：模型拆题 → 每题在题库里检索 → 原题（字面足够像、数字一致、题库有答案）当场给答案 → 存一条搜题记录；
 *   answer：其余题带参考题交给模型作答 → 写回记录。
 *
 * 搜题记录只是用户自己的历史，不回流题库。
 */
import type { Db, LLM, LlmImage } from '@career/core';

import type { CoreIds } from '../store';
import { ExamBankStore, type BankMatch } from './bank';
import { answerQuestions, recognizeQuestions, type QuestionAnswer, type RecognizedQuestion } from './llm-steps';
import type { SearchContext } from './match';
import { ensureExamSearchSchema } from './schema';

/** 每道题带回界面的候选数：第一条可能是原题，其余当类似题展示。 */
const MATCHES_PER_QUESTION = 4;
/** 历史列表默认条数。 */
export const HISTORY_LIMIT = 50;

export type SearchQuestion = RecognizedQuestion & { matches: BankMatch[] };
export type SearchStatus = 'recognized' | 'answered' | 'failed';

export interface ExamSearchRecord {
  id: string;
  company_name: string | null;
  role_title: string | null;
  input_kind: 'image' | 'text';
  input_text: string | null;
  questions: SearchQuestion[];
  answers: QuestionAnswer[];
  status: SearchStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ExamSearchRow extends Omit<ExamSearchRecord, 'questions' | 'answers'> { questions_json: string; answers_json: string }

export interface RecognizeInput { image?: LlmImage; text?: string; companyName?: string | null; roleTitle?: string | null }

export function questionText(q: Pick<RecognizedQuestion, 'stem' | 'options'>): string {
  return [q.stem, ...q.options].join(' ');
}

/** 题库原题：是同一道题且题库给了答案，直接用题库答案，不再问模型。 */
export function bankAnswer(q: SearchQuestion): QuestionAnswer | null {
  const top = q.matches[0];
  if (!top?.same || !top.answer) return null;
  return { index: q.index, answer: top.answer, explanation: top.explanation ?? '', confidence: 'high', source: 'bank', ref_item_id: top.item_id };
}

export class ExamSearchService {
  readonly bank: ExamBankStore;
  constructor(private readonly db: Db, private readonly ids: CoreIds, private readonly llm: LLM) {
    ensureExamSearchSchema(db);
    this.bank = new ExamBankStore(db, ids);
  }

  async recognize(input: RecognizeInput): Promise<ExamSearchRecord> {
    const recognition = await recognizeQuestions(this.llm, { image: input.image, text: input.text });
    const ctx: SearchContext = {
      companyName: input.companyName?.trim() || recognition.company_hint,
      roleTitle: input.roleTitle?.trim() || recognition.role_hint,
    };
    const questions = recognition.questions.map(q => ({ ...q, matches: this.bank.search(questionText(q), ctx, MATCHES_PER_QUESTION) }));
    const answers = questions.map(bankAnswer).filter((a): a is QuestionAnswer => a !== null);
    const done = answers.length === questions.length;
    const t = this.ids.now();
    const id = this.ids.newId('exs');
    this.db.insert('exam_search', {
      id, company_name: ctx.companyName, role_title: ctx.roleTitle,
      input_kind: input.image ? 'image' : 'text', input_text: input.text?.trim() || null,
      questions_json: JSON.stringify(questions), answers_json: JSON.stringify(answers),
      status: done ? 'answered' : 'recognized', created_at: t, updated_at: t,
    });
    console.log(`[exam-search] recognized ${id}: ${questions.length} 题，题库原题 ${answers.length}`);
    return this.get(id)!;
  }

  /** 给还没答案的题作答；模型失败时把原因写进记录再抛出，界面能看到哪一步坏了。 */
  async answer(id: string): Promise<ExamSearchRecord> {
    const record = this.get(id);
    if (!record) throw new Error(`搜题记录不存在：${id}`);
    const answered = new Set(record.answers.map(a => a.index));
    const pending = record.questions.filter(q => !answered.has(q.index));
    if (pending.length === 0) return record;
    const ctx: SearchContext = { companyName: record.company_name, roleTitle: record.role_title };
    try {
      const fresh = await this.answerAll(pending, ctx);
      const answers = [...record.answers, ...fresh].sort((a, b) => a.index - b.index);
      this.db.update('exam_search', id, { answers_json: JSON.stringify(answers), status: 'answered', error: null, updated_at: this.ids.now() });
      console.log(`[exam-search] answered ${id}: 模型作答 ${fresh.length} / ${pending.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.update('exam_search', id, { status: 'failed', error: message, updated_at: this.ids.now() });
      console.error(`[exam-search] FAILED answer ${id}: ${message}`);
      throw error;
    }
    return this.get(id)!;
  }

  /** 模型偶尔漏答几道：漏掉的再问一次，还漏就如实留空（界面显示「没有答案」）。 */
  private async answerAll(pending: SearchQuestion[], ctx: SearchContext): Promise<QuestionAnswer[]> {
    const first = await answerQuestions(this.llm, pending, ctx);
    const got = new Set(first.map(a => a.index));
    const missing = pending.filter(q => !got.has(q.index));
    if (missing.length === 0) return first;
    console.warn(`[exam-search] 模型漏答 ${missing.length} 题，重问一次`);
    return [...first, ...await answerQuestions(this.llm, missing, ctx)];
  }

  get(id: string): ExamSearchRecord | undefined {
    const row = this.db.get<ExamSearchRow>('SELECT * FROM exam_search WHERE id=?', [id]);
    return row ? toRecord(row) : undefined;
  }

  list(limit = HISTORY_LIMIT): ExamSearchRecord[] {
    return this.db.all<ExamSearchRow>('SELECT * FROM exam_search ORDER BY created_at DESC LIMIT ?', [limit]).map(toRecord);
  }

  remove(id: string): boolean {
    return this.db.run('DELETE FROM exam_search WHERE id=?', [id]).changes > 0;
  }
}

function parseList<T>(raw: string, what: string, id: string): T[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch (error) {
    console.warn(`[exam-search] 记录 ${id} 的 ${what} 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function toRecord(row: ExamSearchRow): ExamSearchRecord {
  const { questions_json, answers_json, ...rest } = row;
  return { ...rest, questions: parseList<SearchQuestion>(questions_json, 'questions', row.id), answers: parseList<QuestionAnswer>(answers_json, 'answers', row.id) };
}

/** 「这场笔试」的候选：最近的笔试、测评期限（几小时前开考的也算，可能正在考）。 */
const CONTEXT_LOOKBACK_MS = 4 * 3_600_000;
const CONTEXT_LOOKAHEAD_MS = 7 * 24 * 3_600_000;
const CONTEXT_LIMIT = 5;

export interface ExamContext { deadline_id: string; kind: string; title: string; due_at: string; company_name: string | null; role_title: string | null }

export function upcomingExamContexts(db: Db, now = new Date()): ExamContext[] {
  const from = new Date(now.getTime() - CONTEXT_LOOKBACK_MS).toISOString();
  const to = new Date(now.getTime() + CONTEXT_LOOKAHEAD_MS).toISOString();
  return db.all<ExamContext>(
    `SELECT d.id AS deadline_id, d.kind, d.title, d.due_at, j.company_name, j.title AS role_title
       FROM deadline d
       LEFT JOIN application a ON a.id = d.application_id
       LEFT JOIN job j ON j.id = COALESCE(d.job_id, a.job_id)
      WHERE d.kind IN ('written_test', 'assessment') AND d.status = 'open' AND d.due_at BETWEEN ? AND ?
      ORDER BY ABS(julianday(d.due_at) - julianday(?)) LIMIT ?`,
    [from, to, now.toISOString(), CONTEXT_LIMIT],
  );
}
