/**
 * 笔试搜题的三张表（只在壳里用，不进 @career/core 的迁移）：
 *   - exam_bank：一套题库（我们整理的 builtin / 用户上传的 user），带公司、岗位、年份；
 *   - exam_bank_item：题库里的一道题（题干、选项、答案、解析），岗位归一成岗位族方便跨公司检索；
 *   - exam_bank_fts：题干 + 选项的 trigram 全文索引（中文按三字切，召回候选再在 JS 里精排）；
 *   - exam_session：一场笔试（搜题记录按场归在一起，翻看、回看都以场为单位）；
 *   - exam_search：这场里的一次粘贴（只是用户自己的历史，不回流题库）。不存截图：认题时模型抄下的
 *     题干、选项、题型（questions_json）和共用材料（material）就是这一步的内容，前端统一重新排版。
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
  db.raw.exec(`CREATE TABLE IF NOT EXISTS exam_session (
    id TEXT PRIMARY KEY,
    company_name TEXT, role_title TEXT,
    live_at TEXT,                             -- 点了「开始这场」：宠物点一下就截图，截的图记进这场；同时最多一场
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.raw.exec(`CREATE TABLE IF NOT EXISTS exam_search (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES exam_session(id) ON DELETE CASCADE,
    company_name TEXT, role_title TEXT,
    input_kind TEXT NOT NULL,                 -- image|text
    input_text TEXT,
    material TEXT,
    questions_json TEXT NOT NULL DEFAULT '[]',
    answers_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'recognized', -- recognized|answered|failed
    error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  addSessionColumn(db);
  if (!hasColumn(db, 'exam_session', 'live_at')) db.raw.exec('ALTER TABLE exam_session ADD COLUMN live_at TEXT');
  if (!hasColumn(db, 'exam_search', 'material')) db.raw.exec('ALTER TABLE exam_search ADD COLUMN material TEXT');
  db.raw.exec('CREATE INDEX IF NOT EXISTS idx_exam_search_created ON exam_search(created_at)');
  db.raw.exec('CREATE INDEX IF NOT EXISTS idx_exam_search_session ON exam_search(session_id, created_at)');
  ensured.add(db);
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).some(c => c.name === column);
}

/** 早先的表没有 session_id：补上列，旧记录各自成一场，记录页里照样看得到。 */
function addSessionColumn(db: Db): void {
  if (hasColumn(db, 'exam_search', 'session_id')) return;
  db.raw.exec('ALTER TABLE exam_search ADD COLUMN session_id TEXT REFERENCES exam_session(id) ON DELETE CASCADE');
  db.raw.exec(`INSERT INTO exam_session (id, company_name, role_title, created_at, updated_at)
    SELECT 'exm_' || id, company_name, role_title, created_at, updated_at FROM exam_search`);
  db.raw.exec("UPDATE exam_search SET session_id = 'exm_' || id");
  console.log('[exam-search] exam_search 补上 session_id，旧记录各自成一场');
}
