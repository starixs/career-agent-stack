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

-- ===== 简历工作台的排版数据（resume-studio ResumeData：模板 / 布局 / 字体 / 配色 / 富文本） =====
-- 内容的权威仍是 resume_master / resume_tailored.schema_json（工具、定制、导出都读它）；
-- 这里存工作台的完整文档。编辑器保存时回写内容；内容被工具改过（updated_at 更新）时按新内容重建、保留排版。
CREATE TABLE IF NOT EXISTS resume_design (
  resume_id TEXT PRIMARY KEY,        -- resume_master.id 或 resume_tailored.id
  data_json TEXT NOT NULL,
  content_updated_at TEXT,           -- 生成 / 保存这份排版时对应的内容版本（resume.updated_at）
  updated_at TEXT NOT NULL
);

-- ===== 对话内流程卡片（挂在产生它的那次工具调用下面；完成 / 忽略后折叠） =====
CREATE TABLE IF NOT EXISTS chat_card (
  id TEXT PRIMARY KEY,               -- 稳定的领域 id（needs_user:<action> / claims:<exp> …），同 id 覆盖
  session_id TEXT,                   -- 产生它的对话
  tool_use_id TEXT,                  -- 锚点：产生它的工具调用；后台批量等无锚点时为空
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  data_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | dismissed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_card_session ON chat_card(session_id, created_at);
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

-- ===== 私密信息库（不进模型上下文） =====
-- 值一律 AES-256-GCM 加密后落库；模型侧只能看到 scope/field/preview 与占位符 {{vault:...}}。
CREATE TABLE IF NOT EXISTS vault_item (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,             -- profile（本人基本信息）|site（投递网站账号）|experience（经历的保密补充）
  ref_id TEXT NOT NULL DEFAULT '', -- site: 站点 host；experience: experience.id；profile: ''
  field TEXT NOT NULL,             -- profile: name/phone/email/idNumber…；site: username/password/note；experience: 任意字段名
  label TEXT,                      -- 展示名（用户可改）
  ciphertext BLOB NOT NULL,        -- iv(12) + tag(16) + data
  preview TEXT,                    -- 脱敏预览，如 138****0000；密码类为空
  sensitive INTEGER NOT NULL DEFAULT 1,  -- 1 = 模型侧只给占位符；0 = 允许以明文给模型（如学校/专业）
  policy_json TEXT NOT NULL DEFAULT '{}',-- {autofill:boolean}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, ref_id, field)
);
CREATE TABLE IF NOT EXISTS vault_access_log (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  actor TEXT NOT NULL,             -- ui|form_fill|login_fill|resume_export|resolve
  purpose TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_item_scope ON vault_item(scope, ref_id);
-- ===== 收件箱 / 截止 / 卷宗 / 素材 / 复盘 / 邮箱（围绕时间与状态的五个面，《产品落地计划》§11） =====
-- 收件箱：任何丢进来的东西（粘贴、邮件、文件）先落这里，再由助理归类成结构化对象。
CREATE TABLE IF NOT EXISTS inbox_item (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'paste',     -- paste|mail|file|url|chat
  raw_text TEXT NOT NULL,
  kind TEXT,                                -- jd|interview_invite|assessment|written_test|rejection|offer|referral|deadline|other
  status TEXT NOT NULL DEFAULT 'new',       -- new|processed|dismissed
  parsed_json TEXT,                         -- 助理抽取的结构化字段
  linked_type TEXT,                         -- job|application|interview|offer|deadline
  linked_id TEXT,
  mail_message_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_item(status, created_at);

-- 截止与定时事件：不丢球（测评 72h、笔试时间、面试时间、三方 / offer 回复截止、内推码过期）。
CREATE TABLE IF NOT EXISTS deadline (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- assessment|written_test|interview|application_deadline|offer_reply|referral_expiry|other
  title TEXT NOT NULL,
  due_at TEXT NOT NULL,                     -- ISO 时间
  application_id TEXT REFERENCES application(id) ON DELETE CASCADE,
  job_id TEXT,
  interview_id TEXT,
  offer_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',    -- manual|inbox|mail|agent|job
  status TEXT NOT NULL DEFAULT 'open',      -- open|done|missed|cancelled
  url TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deadline_due ON deadline(status, due_at);

-- 卷宗笔记：这条投递里说过什么 / 听到什么 / 联系人 / 内推人，面试前一键摊开。
CREATE TABLE IF NOT EXISTS dossier_note (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',        -- note|said|heard|contact|referral|mail
  round TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dossier_note_app ON dossier_note(application_id, created_at);

-- 素材：可复用的说法（开放题答案、项目故事、自我介绍……），带来源主张；answer_bank 继续承担网申字段原话。
CREATE TABLE IF NOT EXISTS material (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- open_question|project_story|self_intro|why_company|why_role|strength_weakness|career_plan|other
  title TEXT NOT NULL,
  question_key TEXT,                        -- 归一化问题键（开放题）
  content TEXT NOT NULL,
  length_variant TEXT,                      -- short|medium|long
  claim_ids_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  company_scope TEXT,                       -- 只对某家公司适用时填公司名
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 素材使用记录：对哪家公司、在哪个场合说过什么，保证前后一致。
CREATE TABLE IF NOT EXISTS material_use (
  id TEXT PRIMARY KEY,
  material_id TEXT REFERENCES material(id) ON DELETE SET NULL,
  application_id TEXT REFERENCES application(id) ON DELETE CASCADE,
  job_id TEXT,
  company_name TEXT,
  context TEXT NOT NULL,                    -- 网申|邮件|招呼语|面试-hr|面试-一面|…
  content_snapshot TEXT NOT NULL,
  used_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_material_use_company ON material_use(company_name, used_at);

-- 每周复盘：漏斗 + 代理反馈 + 策略调整建议。
CREATE TABLE IF NOT EXISTS weekly_review (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,                 -- YYYY-MM-DD（周一）
  funnel_json TEXT NOT NULL,
  insights_json TEXT NOT NULL DEFAULT '[]',
  suggestions_json TEXT NOT NULL DEFAULT '[]',
  small_action TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weekly_review_week ON weekly_review(week_start);

-- 邮箱账号与邮件：收件自动进收件箱，发件只能从待审队列执行。授权码不进库（放本机 0600 文件）。
CREATE TABLE IF NOT EXISTS mail_account (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                   -- qq|163|126|gmail|outlook|imap
  address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL DEFAULT 993,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL DEFAULT 465,
  status TEXT NOT NULL DEFAULT 'unverified',-- unverified|ok|auth_failed|error
  last_sync_at TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_message (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_account(id) ON DELETE CASCADE,
  uid INTEGER,
  message_id TEXT,
  in_reply_to TEXT,
  direction TEXT NOT NULL,                  -- in|out
  from_addr TEXT, to_addr TEXT,
  subject TEXT,
  snippet TEXT,
  body_text TEXT,
  received_at TEXT,
  relevance TEXT NOT NULL DEFAULT 'unknown',-- unknown|job|ignored
  kind TEXT,                                -- 与 inbox_item.kind 同枚举
  inbox_item_id TEXT,
  application_id TEXT,
  action_id TEXT,                           -- 发件对应的待审动作
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_message_uid ON mail_message(account_id, uid);
CREATE INDEX IF NOT EXISTS idx_mail_message_app ON mail_message(application_id, received_at);
