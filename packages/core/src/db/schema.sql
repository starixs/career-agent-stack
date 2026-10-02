-- 中国求职 Agent 统一数据模型（对应《产品落地计划》§4）。单库 SQLite。
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

-- ===== 真实经历库 =====
CREATE TABLE IF NOT EXISTS experience (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  role TEXT,
  org TEXT,
  start_date TEXT,
  end_date TEXT,
  type TEXT NOT NULL DEFAULT 'other',      -- dev|data|pm|ops|design|marketing|finance|education|admin|other
  summary TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,     -- 1 = 用户只提供了脱敏摘要
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claim (
  id TEXT PRIMARY KEY,
  experience_id TEXT NOT NULL REFERENCES experience(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  attribution TEXT NOT NULL DEFAULT 'unknown',   -- self|team|unknown
  result_metric TEXT,
  status TEXT NOT NULL DEFAULT 'pending',        -- verified|pending|user_confirmed
  created_from TEXT NOT NULL DEFAULT 'interview',-- interview|doc|repo|link|manual
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- code|commit|pr|doc_fragment|url|file|oral|screenshot
  locator TEXT NOT NULL,         -- file:line@commit / doc:page:bbox / url / 文件路径
  excerpt TEXT,
  strength TEXT NOT NULL DEFAULT 'weak',  -- strong|mid|weak
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_experience ON claim(experience_id);
CREATE INDEX IF NOT EXISTS idx_evidence_claim ON evidence(claim_id);

-- ===== 简历 =====
CREATE TABLE IF NOT EXISTS resume_master (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT,                -- 职业线/方向
  schema_json TEXT NOT NULL,     -- resume schema JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resume_snapshot (
  id TEXT PRIMARY KEY,
  resume_id TEXT NOT NULL,       -- master 或 tailored 的 id
  schema_json TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resume_tailored (
  id TEXT PRIMARY KEY,
  master_id TEXT NOT NULL REFERENCES resume_master(id) ON DELETE CASCADE,
  job_id TEXT,
  schema_json TEXT NOT NULL,
  strength TEXT NOT NULL DEFAULT 'keywords',   -- nudge|keywords|full
  diff_confirmed_at TEXT,
  export_pdf TEXT, export_docx TEXT, export_png TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ===== 公司与岗位 =====
CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY,
  legal_name TEXT,
  brand_names TEXT NOT NULL DEFAULT '[]',   -- JSON array
  dd_report_json TEXT,                       -- 公司研究九段报告
  traffic_light TEXT,                        -- red|yellow|green
  manual_checks TEXT NOT NULL DEFAULT '[]',  -- JSON array 人工核实清单
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL,   -- boss|liepin|zhilian|51job|campus|ats|manual
  source_job_id TEXT,
  url TEXT,
  company_id TEXT REFERENCES company(id),
  company_name TEXT,
  title TEXT NOT NULL,
  location TEXT,
  salary TEXT,
  jd_raw TEXT,
  jd_parsed_json TEXT,             -- 九类分析 + 关键词三分类
  prefilter_json TEXT,             -- 硬约束结果
  score_json TEXT,                 -- 五维评分
  deadline TEXT,
  deadline_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_platform, source_job_id)
);
CREATE INDEX IF NOT EXISTS idx_job_company_title ON job(company_name, title, location);

-- ===== 投递台 =====
CREATE TABLE IF NOT EXISTS application (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  resume_tailored_id TEXT REFERENCES resume_tailored(id),
  stage TEXT NOT NULL DEFAULT 'evaluated',
  next_action TEXT,
  next_action_due TEXT,
  blocker_reason TEXT,
  retry_strategy TEXT,
  submission_evidence TEXT,
  answers_used_json TEXT NOT NULL DEFAULT '{}',
  page_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS application_history (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  from_stage TEXT, to_stage TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_queue (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES application(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,              -- fill_form|submit|send_greeting|upload|answer_open_q|collect|research
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review|approved|executing|needs_user|done|failed|rejected
  result_json TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff (
  id TEXT PRIMARY KEY,
  action_id TEXT REFERENCES action_queue(id) ON DELETE SET NULL,
  task_id TEXT,
  reason TEXT NOT NULL,            -- captcha|login|2fa|assessment|submit_confirm|missing_info|user_request
  message TEXT,
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  resumed_from_step TEXT
);

-- ===== 任务与会话（对话工作台） =====
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,              -- intake|tailor|research|collect|apply|interview|direction|gap|offer|chat
  status TEXT NOT NULL DEFAULT 'queued',  -- queued|running|paused|needs_user|done|failed|cancelled
  progress REAL NOT NULL DEFAULT 0,
  step TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',  -- token / 浏览器时长计量
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- user|assistant|tool|system
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id, created_at);

-- ===== 面试 =====
CREATE TABLE IF NOT EXISTS interview (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES application(id) ON DELETE SET NULL,
  company_name TEXT, title TEXT,
  round TEXT NOT NULL,             -- hr|first|second|final|group|other
  date TEXT,
  interviewer_role_guess TEXT,
  transcript TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  retro_json TEXT,
  result TEXT NOT NULL DEFAULT 'none',          -- none|rejected|advanced|no_feedback_inferred
  result_source TEXT NOT NULL DEFAULT 'none',   -- none|official|inferred
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probe_prediction (
  id TEXT PRIMARY KEY,
  resume_tailored_id TEXT,
  claim_id TEXT,
  statement TEXT NOT NULL,
  target_type TEXT NOT NULL,       -- data|project|industry|method
  expected_chain_json TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL DEFAULT 'mid',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_interview (
  id TEXT PRIMARY KEY,
  job_id TEXT, resume_tailored_id TEXT,
  mode TEXT NOT NULL,              -- probe|question_bank|project_story
  company_type TEXT, round TEXT,
  turns_json TEXT NOT NULL DEFAULT '[]',
  report_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- ===== 方向 / 差距 / Offer =====
CREATE TABLE IF NOT EXISTS direction (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',   -- candidate|tentative|chosen|dropped
  rationale_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gap_plan (
  id TEXT PRIMARY KEY,
  job_id TEXT, direction_id TEXT,
  gaps_json TEXT NOT NULL,         -- {have:[],need_evidence:[],missing:[]}
  actions_json TEXT NOT NULL,      -- 可验收的小任务
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offer (
  id TEXT PRIMARY KEY,
  application_id TEXT REFERENCES application(id) ON DELETE SET NULL,
  company_name TEXT, title TEXT,
  comp_json TEXT NOT NULL DEFAULT '{}',
  location TEXT,
  content_match TEXT,
  risk_notes TEXT,
  deadline TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- ===== 用户设置与答案库（网申） =====
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answer_bank (
  id TEXT PRIMARY KEY,
  question_key TEXT NOT NULL,      -- 归一化后的问题键
  question_text TEXT NOT NULL,
  answer TEXT NOT NULL,
  high_impact INTEGER NOT NULL DEFAULT 0,  -- 薪资/签证等只能原话填
  confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answer_bank_key ON answer_bank(question_key);
