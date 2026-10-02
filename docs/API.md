# 产品内部接口契约（shell ⇄ 前端 ⇄ 工具）

所有接口都在 keystone 壳的 Node 侧车上。**Global 路由**前缀 `/api/career/`（无会话依赖，直接读写 SQLite），**Session 路由**前缀 `/api/career-session/`（依赖当前对话会话，用于接管与审核回传）。两个前缀都要登记在 `src/server/sidecar-composition.ts`。响应统一 `{ ok: true, ...data }` 或 `{ ok: false, error: string }`。数据结构以 `packages/core/src/types.ts` 为准。

## Global：`/api/career/*`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/career/overview` | 首页概览：`{ board, tasks(running/needs_user), openHandoffs, pendingReview }` |
| GET | `/api/career/experiences` | `Repos.experienceTree()` |
| POST | `/api/career/experiences` | `{title, role?, org?, start_date?, end_date?, type?, summary?, redacted?}` → experience |
| POST | `/api/career/claims` | `{experience_id, text, attribution?, result_metric?, created_from?}` → claim |
| POST | `/api/career/claims/:id/confirm` | 用户确认主张 |
| POST | `/api/career/evidence` | `{claim_id, kind, locator, excerpt?, strength?}` |
| GET | `/api/career/resumes` | `{ masters: ResumeMaster[], tailored: ResumeTailored[] }` |
| POST | `/api/career/resumes/master` | `{name, direction?, schema_json?}` |
| PUT | `/api/career/resumes/:id` | `{schema_json}`（保存并写快照） |
| POST | `/api/career/resumes/:id/export` | `{format:'pdf'|'docx'|'png'}` → `{path}`（文件写到 `CAREER_DATA_DIR/exports/`） |
| GET | `/api/career/resumes/:id/file?format=pdf` | 返回文件流（预览） |
| GET | `/api/career/jobs` | job[] |
| POST | `/api/career/jobs/import` | `{url?, jd_raw?, title?, company_name?, source_platform?}` → job（链接导入） |
| GET | `/api/career/applications` | `application[]`，每条 join job 的 title/company_name/deadline |
| GET | `/api/career/board` | `Repos.board()` |
| POST | `/api/career/applications/:id/stage` | `{to, note?, extra?}` → application |
| GET | `/api/career/actions?status=pending_review` | 动作队列 |
| POST | `/api/career/actions/review` | `{ids:string[], decision:'approved'|'rejected'}` → `{n}` |
| GET | `/api/career/handoffs` | 未关闭的接管 |
| POST | `/api/career/handoffs/:id/close` | `{resumed_from_step?}` |
| GET | `/api/career/tasks` | task[] |
| GET | `/api/career/companies` | company[] |
| GET | `/api/career/interviews` | interview[] |
| POST | `/api/career/interviews` | 新建面试记录 |
| PUT | `/api/career/interviews/:id` | 更新（transcript / tags / retro / result / result_source） |
| GET | `/api/career/mock-interviews` | mock_interview[] |
| GET | `/api/career/directions` | direction[] |
| POST | `/api/career/directions/:id/status` | `{status}` |
| GET | `/api/career/gap-plans` | gap_plan[] |
| GET | `/api/career/offers` | offer[] |
| POST/PUT | `/api/career/offers[/:id]` | 新建 / 更新 |
| GET | `/api/career/answer-bank` | answer_bank[] |
| POST | `/api/career/answer-bank` | `{question_key, question_text, answer, high_impact?, confirmed?}` |
| GET | `/api/career/today` | 今日队列 `{items: TodayItem[], waiting, inbox_new, pending_review}`（排序：过期 / 今天 → 待审 → 接管 → 今日面试 → 新收件 → 静默） |
| GET | `/api/career/onboarding` | 首次引导清单 `{checklist}` |
| GET / POST | `/api/career/inbox` | 收件箱列表（`?status=new`）/ `{text, source?, application_id?}` → 归档结果 `{result}` |
| POST | `/api/career/inbox/:id/dismiss` · `/retry` | 忽略 / 重新识别（可带 application_id） |
| GET / POST | `/api/career/deadlines` | 截止事件（`?status=open|open_or_missed|…`）/ `{kind, title, due_at, application_id?, job_id?, url?, note?}` |
| POST | `/api/career/deadlines/:id/status` | `{status: open|done|missed|cancelled}` |
| GET | `/api/career/dossiers` · `/dossiers/:applicationId` | 卷宗摘要 / 完整卷宗（简历版本、说过的话、邮件、截止、面试、Offer、待审动作、时间线、预测） |
| POST | `/api/career/dossiers/:id/notes` | `{kind: note|said|heard|contact|referral, round?, content}` |
| POST | `/api/career/applications/:id/close-silent` | 静默超时关闭（→ discarded 并写笔记） |
| GET / POST / PUT / DELETE | `/api/career/materials[/:id]` | 素材库 CRUD（`?kind=`） |
| GET / POST | `/api/career/materials/uses` | 使用记录（`?application_id=&company_name=&material_id=`）/ `{material_id?, application_id?, company_name?, context, content_snapshot}` |
| POST | `/api/career/materials/draft` | `{kind, question, length?, job_id?, application_id?, company_name?}` → 草稿 + conflicts（需模型） |
| GET | `/api/career/review` | `{funnel: {overall, by_category, by_platform}, reviews}` |
| POST | `/api/career/review/weekly` | `{week_start?, user_note?}` → 生成并保存周复盘（无模型时只存漏斗） |
| GET / POST | `/api/career/mail/accounts` | 账号与预设 / 绑定 `{address, password?, provider?, display_name?, imap_host?, smtp_host?, verify?}`（立即同步一次验证） |
| DELETE | `/api/career/mail/accounts/:id` | 解绑并删除本机授权码 |
| POST | `/api/career/mail/sync` | `{account_id?}` → 同步结果（新邮件进收件箱 / 卷宗） |
| GET | `/api/career/mail/messages` | `?application_id=&direction=in|out&relevance=job&limit=` |

### Global：浏览器（供 Session 工具调用，Bearer token = browser capability token）
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/career/browser/control` | `{control:'agent'|'human', reason?}` → `{control}`；切到 human 时把浏览器窗口前置 |
| GET | `/api/career/browser/state` | `{control, url, title}` |
| POST | `/api/career/browser/run` | `{op:'diagnose'|'drive'|'collect_passive'|'screenshot', ...}`，NDJSON 流式返回进度与结果 |

## Session：`/api/career-session/*`
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/career-session/takeover` | `{runId, action:'take'|'handback', resumedFromStep?}` |
| POST | `/api/career-session/review` | `{actionIds, decision}`（对话内审核卡片回传，内部同 Global review） |

## SSE 事件（Session 侧车 → 前端）
在 `src/server/sse.ts` 的 `SSE_EVENT_PRIORITIES` 登记，在 `src/renderer/api/SseConnection.ts` 的 `JSON_EVENTS` 登记，在 `TabProvider.tsx` 加 case 并 `emitEvent` 到 eventBus 供其他页面订阅。
- `career:progress` `{sessionId, taskId?, runId?, phase, message, progress?}`（coalescible）
- `career:takeover` `{sessionId, runId, state:'running'|'paused'|'human_active'|'resuming', reason?, url?, message?}`（critical）
- `career:review` `{sessionId, actionIds:string[], kind, summary}`（critical）
- `career:data-changed` `{sessionId, tables:string[]}`（coalescible；页面据此刷新）
- `career:focus` `{sessionId, surface:'today'|'inbox'|'dossier'|'material'|'review'|'guide', id?, application_id?, job_id?, note?}`（critical；App 打开对应的面，面内定位对象）
- 渲染端内部事件 `career:chat-suggest` `{text, context:{surface, refs, note}}`：面板按钮 → Chat 真正发送（带隐藏对象 id 上下文）

## 常驻工具集 `career`（Pattern 1 注入，用户不可关）
工具只做两类事：读写数据层；把需要执行的动作入队或触发 run。**submit / send_greeting / answer_open_q / send_mail 永远只入待审队列。** 写库后尽量调用 `focus()` 推 `career:focus`。

| 工具 | 参数 | 行为 |
|---|---|---|
| `career_overview` | – | 返回看板三问题 + 待审数 + 进行中的任务 |
| `experience_add` | experience + claims[] | 写经历库（claims 状态 pending） |
| `experience_list` | – | 经历树 |
| `claim_confirm` | claim_id | 用户口头确认后调用 |
| `ingest_document` | path | docparse → 抽取 claims（pending） |
| `ingest_repo` | repoPath, author? | repoMiner → claims + commit 证据 |
| `jd_parse` | jd_raw \| url | → JdParsed，存入 job |
| `job_import` | url \| jd_raw | 入岗位池并解析 |
| `job_evaluate` | job_id | 预筛 + 五维评分 |
| `resume_list` | – | 主简历 + 定制版清单（找 master_id 用） |
| `resume_master_create` | name?, direction?, basics?, education?, draft? | 创建主简历；缺省用 resume-draft 技能从已确认主张起草，basics / education 只搬运用户给的信息 |
| `resume_get` | resume_id? | 读取简历完整 JSON（缺省唯一主简历） |
| `resume_save` | resume_id?, resume \| patch | 按用户要求改简历并保存（先存快照） |
| `resume_tailor` | master_id?, job_id, strength | 生成 JSON Patch 提案（不落库），返回 diff 摘要；master_id 缺省取唯一主简历 |
| `resume_confirm` | tailored_id | 用户确认 diff 后落库 |
| `resume_export` | resume_id, format | 导出并返回路径 |
| `company_research` | company_name | intel-compass 九段报告 → company 表 |
| `web_search` | query, count? | 唯一的外部动作 |
| `apply_prepare` | job_id, resume_id | 入队 fill_form（需审核）并创建 application |
| `apply_run` | action_id | 在托管浏览器上执行填表 run（不提交）；遇验证码等 → handoff |
| `greeting_compose` | job_id | 生成招呼语并入队 send_greeting（待审） |
| `review_queue` | status? | 列出待审动作 |
| `interview_*` | … | questions / probe / project_story / retro / predict |
| `direction_explore` | prefs | 结合 web_search 给 2–3 个方向 |
| `gap_plan` | job_id | 差距三分类 + 可验收任务 |
| `offer_compare` | offer_ids | 对比表 |
| `today_queue` | – | 今日队列（给用户最多三件） |
| `inbox_capture` | text, source?, application_id? | 归档任何内容：建岗位 / 面试 / 截止 / 关闭投递 / Offer |
| `inbox_list` / `inbox_dismiss` | status? / inbox_id | 收件箱列表 / 忽略 |
| `deadline_add` / `deadline_done` | kind, title, due_at… / deadline_id | 不能丢的时间点 |
| `dossier_list` / `dossier_get` | – / application_id \| job_id \| company_name | 卷宗摘要 / 面试前一键摊开 |
| `dossier_note_add` | application_id, kind, round?, content | 说过的 / 听到的 / 联系人 |
| `application_set_stage` | application_id, stage, note? | 沿状态机合法路径推进或关闭 |
| `material_list` / `material_draft` / `material_save` / `material_use_record` | … | 素材库：复用优先 + 一致性核对 |
| `weekly_review` | week_start?, user_note? | 漏斗 + 代理反馈 + 一个小动作 |
| `mail_accounts` / `mail_sync` / `mail_list` | – / account_id? / application_id? | 邮箱（绑定在面板完成，授权码不进对话） |
| `mail_compose` | to, job_id \| application_id, resume_id?, notes? | 起草投递邮件（可附简历 PDF）并入待审队列 `send_mail` |

工具执行中用 `broadcast('career:progress', …)` 推进度；数据变更后 `broadcast('career:data-changed', …)`。
