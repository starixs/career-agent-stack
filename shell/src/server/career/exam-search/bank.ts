/**
 * 题库的读写与检索。题库是搜题的检索来源：我们整理的（builtin）+ 用户上传的（user）；
 * 用户搜过的题不写进来（世界模型「题」）。
 */
import type { Db } from '@career/core';

import type { CoreIds } from '../store';
import { ensureExamSearchSchema } from './schema';
import { SIMILAR_MIN, isSameQuestion, rankScore, roleFamily, stemSimilarity, tierOf, trigramQuery, type MatchTier, type SearchContext } from './match';

export type BankOrigin = 'builtin' | 'user';
export type QuestionType = 'single' | 'multi' | 'judge' | 'fill' | 'short' | 'personality';
export const QUESTION_TYPES: readonly QuestionType[] = ['single', 'multi', 'judge', 'fill', 'short', 'personality'];

export type BankStatus = 'importing' | 'ready' | 'failed';
export interface ExamBank { id: string; name: string; origin: BankOrigin; company_name: string | null; role_title: string | null; year: number | null; source_file: string | null; item_count: number; status: BankStatus; error: string | null; created_at: string }
export interface ExamBankItemRow { id: string; bank_id: string; stem: string; options_json: string; answer: string | null; explanation: string | null; qtype: string | null; company_name: string | null; role_title: string | null; role_family: string | null; year: number | null; created_at: string }

export interface BankItemInput { stem: string; options?: string[]; answer?: string | null; explanation?: string | null; qtype?: QuestionType | null; company_name?: string | null; role_title?: string | null; year?: number | null }
export interface BankInput { name: string; origin: BankOrigin; company_name?: string | null; role_title?: string | null; year?: number | null; source_file?: string | null; id?: string }

export interface BankMatch {
  item_id: string;
  stem: string;
  options: string[];
  answer: string | null;
  explanation: string | null;
  company_name: string | null;
  role_title: string | null;
  year: number | null;
  bank_name: string;
  origin: BankOrigin;
  tier: MatchTier;
  similarity: number;
  /** 就是这道题（字面足够像且数字一致）：有答案时直接用。 */
  same: boolean;
}

/** 全文索引先召回这么多条，再在 JS 里按相似度 + 分级精排。 */
const RECALL_LIMIT = 200;

export class ExamBankStore {
  constructor(private readonly db: Db, private readonly ids: CoreIds) {
    ensureExamSearchSchema(db);
  }

  listBanks(): ExamBank[] {
    return this.db.all<ExamBank>('SELECT * FROM exam_bank ORDER BY origin, created_at DESC');
  }

  getBank(id: string): ExamBank | undefined {
    return this.db.get<ExamBank>('SELECT * FROM exam_bank WHERE id=?', [id]);
  }

  itemCount(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM exam_bank_item')?.n ?? 0;
  }

  /** 新建一套题库；传了 items 就一次写完（ready），不传则处于导入中，由 addItems / finishImport 收尾。 */
  createBank(input: BankInput, items?: BankItemInput[]): ExamBank {
    const id = input.id ?? this.ids.newId('ebk');
    this.db.insert('exam_bank', {
      id, name: input.name, origin: input.origin, company_name: input.company_name ?? null, role_title: input.role_title ?? null,
      year: input.year ?? null, source_file: input.source_file ?? null, item_count: 0, status: items ? 'ready' : 'importing', created_at: this.ids.now(),
    });
    if (items) this.addItems(id, items);
    return this.getBank(id)!;
  }

  /** 写入题目；题目缺公司 / 岗位 / 年份时继承题库的。 */
  addItems(bankId: string, items: BankItemInput[]): void {
    const bank = this.getBank(bankId);
    if (!bank) throw new Error(`题库不存在：${bankId}`);
    const t = this.ids.now();
    this.db.transaction(() => {
      for (const item of items) this.insertItem(bankId, bank, item, t);
      this.db.run('UPDATE exam_bank SET item_count=(SELECT COUNT(*) FROM exam_bank_item WHERE bank_id=?) WHERE id=?', [bankId, bankId]);
    });
  }

  finishImport(bankId: string, error: string | null): void {
    this.db.update('exam_bank', bankId, { status: error ? 'failed' : 'ready', error });
  }

  deleteBank(id: string): boolean {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM exam_bank_fts WHERE item_id IN (SELECT id FROM exam_bank_item WHERE bank_id=?)', [id]);
      this.db.run('DELETE FROM exam_bank_item WHERE bank_id=?', [id]);
      return this.db.run('DELETE FROM exam_bank WHERE id=?', [id]).changes > 0;
    });
  }

  private insertItem(bankId: string, bank: Pick<ExamBank, 'company_name' | 'role_title' | 'year'>, item: BankItemInput, t: string): void {
    const stem = item.stem.trim();
    if (!stem) return;
    const options = (item.options ?? []).map(o => o.trim()).filter(Boolean);
    const role = item.role_title ?? bank.role_title ?? null;
    const id = this.ids.newId('ebi');
    this.db.insert('exam_bank_item', {
      id, bank_id: bankId, stem, options_json: JSON.stringify(options),
      answer: item.answer ?? null, explanation: item.explanation ?? null, qtype: item.qtype ?? null,
      company_name: item.company_name ?? bank.company_name ?? null, role_title: role, role_family: roleFamily(role),
      year: item.year ?? bank.year ?? null, created_at: t,
    });
    this.db.run('INSERT INTO exam_bank_fts(item_id, body) VALUES (?, ?)', [id, [stem, ...options].join('\n')]);
  }

  /** 召回 + 精排：返回按「相似度 + 分级加分」排好的候选，低于 SIMILAR_MIN 的丢掉。 */
  search(text: string, ctx: SearchContext, limit = 5): BankMatch[] {
    const query = trigramQuery(text);
    if (!query) return [];
    const rows = this.db.all<ExamBankItemRow & { bank_name: string; origin: BankOrigin }>(
      `SELECT i.*, b.name AS bank_name, b.origin AS origin
         FROM exam_bank_fts f JOIN exam_bank_item i ON i.id = f.item_id JOIN exam_bank b ON b.id = i.bank_id
        WHERE exam_bank_fts MATCH ? ORDER BY bm25(exam_bank_fts) LIMIT ?`,
      [query, RECALL_LIMIT],
    );
    return rows
      .map(row => toMatch(row, text, ctx))
      .filter(match => match.similarity >= SIMILAR_MIN)
      .sort((a, b) => rankScore(b.similarity, b.tier) - rankScore(a.similarity, a.tier))
      .slice(0, limit);
  }
}

function toMatch(row: ExamBankItemRow & { bank_name: string; origin: BankOrigin }, text: string, ctx: SearchContext): BankMatch {
  const options = parseStringArray(row.options_json);
  const body = [row.stem, ...options].join(' ');
  const similarity = stemSimilarity(text, body);
  return {
    item_id: row.id, stem: row.stem, options, answer: row.answer, explanation: row.explanation,
    company_name: row.company_name, role_title: row.role_title, year: row.year,
    bank_name: row.bank_name, origin: row.origin,
    tier: tierOf(row, ctx),
    similarity,
    same: isSameQuestion(similarity, text, body),
  };
}

export function parseStringArray(raw: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch (error) {
    console.warn(`[exam-search] options_json 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
