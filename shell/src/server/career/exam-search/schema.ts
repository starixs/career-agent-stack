/**
 * 笔试搜题的三张表（只在壳里用，不进 @career/core 的迁移）：
 *   - exam_bank：一套题库（我们整理的 builtin / 用户上传的 user），带公司、岗位、年份；
 *   - exam_bank_item：题库里的一道题（题干、选项、答案、解析），岗位归一成岗位族方便跨公司检索；
 *   - exam_bank_fts：题干 + 选项的 trigram 全文索引（中文按三字切，召回候选再在 JS 里精排）；
 *   - exam_search：每次搜题的记录（只是用户自己的历史，不回流题库）。
 * 建表幂等，打开连接后第一次用到时执行。
 */
import type { Db } from '@career/core';

const ensured = new WeakSet<Db>();

export function ensureExamSearchSchema(db: Db): void {
  if (ensured.has(db)) return;
  db.raw.exec(`CREATE TABLE IF NOT EXISTS exam_bank (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'user',      -- builtin|user
    company_name TEXT, role_title TEXT, year INTEGER,
    source_file TEXT,
    item_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ready',     -- importing|ready|failed
    error TEXT,
    created_at TEXT NOT NULL
  )`);
  db.raw.exec(`CREATE TABLE IF NOT EXISTS exam_bank_item (
    id TEXT PRIMARY KEY,
    bank_id TEXT NOT NULL REFERENCES exam_bank(id) ON DELETE CASCADE,
    stem TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    answer TEXT, explanation TEXT,
    qtype TEXT,                               -- single|multi|judge|fill|short|personality
    company_name TEXT, role_title TEXT, role_family TEXT, year INTEGER,
    created_at TEXT NOT NULL
  )`);
  db.raw.exec('CREATE INDEX IF NOT EXISTS idx_exam_bank_item_bank ON exam_bank_item(bank_id)');
  db.raw.exec("CREATE VIRTUAL TABLE IF NOT EXISTS exam_bank_fts USING fts5(item_id UNINDEXED, body, tokenize='trigram')");
  db.raw.exec(`CREATE TABLE IF NOT EXISTS exam_search (
    id TEXT PRIMARY KEY,
    company_name TEXT, role_title TEXT,
    input_kind TEXT NOT NULL,                 -- image|text
    input_text TEXT,
    questions_json TEXT NOT NULL DEFAULT '[]',
    answers_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'recognized', -- recognized|answered|failed
    error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.raw.exec('CREATE INDEX IF NOT EXISTS idx_exam_search_created ON exam_search(created_at)');
  ensured.add(db);
}
