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
| POST | `/api/career/resumes/:id/confirm` | `{accepted_paths?: string[]}`：把 resume_tailor 的提案（只取勾选的 JSON Pointer 路径，缺省全部）应用到定制简历并确认；与 resume_confirm 工具共用 `career/tailor.ts`。对话内「简历改动」卡片用 |
| GET / PUT | `/api/career/resumes/:id/studio` | 简历工作台文档（resume-studio `ResumeData`）。GET 回 `{data, content_updated_at, rebuilt, preview}`（preview：占位符 → 明文，只给预览用）；PUT `{data}` 回写内容并存排版 |
| GET | `/api/career/cards?session_id=` | 该会话的对话内卡片（含 `toolUseId` 锚点与 `state`） |
| POST | `/api/career/cards/:id/state` | `{state:'pending'|'completed'|'dismissed'}` 完成 / 稍后 / 重新打开 |
| GET | `/api/career/setup` | `{setup:{llm:{configured,source}, search:{configured,source,provider}}}`：只回是否配置与来源（settings / build / none），不回 Key |
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

### Global：私密信息库（UI ⇄ 私密库的唯一明文通道；模型工具永远不走这里）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/career/vault` | `{ status: VaultStatus, items: VaultItemMeta[], profileFields, siteFields }`，只有字段名 / 脱敏预览 / 占位符 |
| PUT | `/api/career/vault/items` | `{scope:'profile'|'site'|'experience', ref_id?, field, value, label?, sensitive?, policy?}` → `{item}`；`value:''` 等于删除；site 的 ref_id 按域名归一化；experience 的 ref_id 必须是存在的经历 |
| POST | `/api/career/vault/items/:id/policy` | `{policy:{autofill?:boolean}}`（站点账号是否在登录页自动代填） |
| DELETE | `/api/career/vault/items/:id` / `/api/career/vault/sites/:host` | 删除一项 / 删除整个站点 |
| POST | `/api/career/vault/items/:id/reveal` | 用户在页面查看 / 编辑时回显明文 → `{value}`；写访问日志 actor=ui |
| GET | `/api/career/vault/access-log?limit=` | 谁在什么时候读过哪一项（form_fill / login_fill / resume_export / ui） |

简历导出（`/resumes/:id/export`、`/file`）在渲染前把 `{{vault:...}}` 占位符解成明文；落库的 `schema_json` 不变。
浏览器 `run` 的 `op:'drive'` 不再要求调用方传 `profile`：资料由 Global 侧车从 SQLite + 私密库组装（`defaultDriveProfile`），返回的 `page` / `result` 事件已脱敏。`drive` 缺省带视觉兜底感知器（`defaultPerceiver`：DOM 盒子 + macOS Vision OCR；`CAREER_VISION_OCR=0` 关闭；`CAREER_VISION_VLM=1` 且模型支持图片时再加视觉模型），`body.vision:false` 可只走 DOM 层；不传 `url` 表示从当前页继续（apply_continue）。`result` 里多了 `userAction` / `captchaKind` / `escalations` / `layersUsed` / `pages[].sections`。
`apply_run` 调 Global 路由时用 capability.url 的 origin 拼路径（capability.url 本身指向 `/mcp/playwright`）。

### Global：浏览器现场 + 批量投递（免令牌；渲染层原生 fetch 直连 Global 端口，响应带 CORS）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/career/live/state` | `{ productSessionId, browser:{hasBrowser, control, url, title, channel, embedded, windowRevealed}, batch: BatchState|null, openHandoffs, fileChooser: {id, multiple, accept, url}|null }` |
| GET | `/api/career/live/stream?frames=1` | NDJSON 长连接：`snapshot` → Global 内部事件（`career:batch` / `career:takeover` / `career:progress` / `career:data-changed` / `career:review`）→ `frame`（CDP screencast JPEG base64，frames=1 时）→ `heartbeat`。**不能走 apiFetch**（Rust 缓冲代理，120s 上限），渲染层用 `useGlobalLive` 直连 |
| POST | `/api/career/live/control` | `{control:'human'|'agent', reason?}`：human 切到用户控制（内嵌窗口模式下不前置真实 Chrome，只有放出真实窗口时才前置）；agent 关闭等待中的填表接管，批量运行器据此续跑 |
| POST | `/api/career/live/input` | `{type:'click'|'move'|'wheel'|'type'|'press', x?, y?, dx?, dy?, text?, key?, double?, frame:{width,height}}`：现场画面里的鼠标 / 键盘转发到托管 Chrome，坐标按帧尺寸换算；只在用户持有控制权时允许（409） |
| POST | `/api/career/live/window` | `{visible:boolean}` → `{revealed}`：临时显示 / 收回真实 Chrome 窗口（内嵌模式的逃生口）；广播 `career:live-window` |
| POST | `/api/career/live/file` | `{id, files:[{name, mimeType?, data(base64)}]}` 把产品内选的文件交给被拦截的选文件框（总计 ≤25MB，单选框只收 1 个）；`{id, cancel:true}` 取消。事件 `career:live-filechooser {state:'open'|'done'|'cancelled'|'expired'}` |
| GET | `/api/career/batch/state` | 批量运行器状态 |
| POST | `/api/career/batch/command` | `{cmd:'start'|'pause'|'stop'}`；Global 里没有运行器实例时写 kv `apply:batch:command` 由运行器轮询 |

渲染层常驻 `CareerLiveBridge` 连一路不带帧的 stream，把 Global 事件转发到本地 eventBus（Global 的 `sse.broadcast` 没有任何客户端，到不了前端）。「浏览器现场」页签（`career-live`）连带帧的 stream；关掉页签只断画面，不影响后台。

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
| `vault_status` | – | 私密信息库概览：已填 / 缺的基本信息字段（脱敏预览）、存了账号的站点、经历的保密字段占位符。**永远不返回明文**；所有工具结果回传前都会把私密库明文换回 `{{vault:...}}` |
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
| `apply_run` | action_id | 在托管浏览器上执行填表 run（不提交）。结果按浏览器路由的 `result.status` 处理：`stopped_before_submit` → submit 进待审队列；`handoff` → 开接管、动作 needs_user、返回 `userAction`（该让用户做什么）；`blocked` / `failed` / 路由 `error` 行 → 动作 failed、投递 blocked |
| `apply_continue` | action_id | 用户在浏览器里处理完登录 / 验证码 / 测评并点"交回"后，从当前页继续填表（不重新打开链接）；复用同一任务，关闭该动作的接管 |
| `apply_batch` | command: start / pause / stop / status | 后台长程批量：把所有已批准的 fill_form 排队由 Global 运行器一份份填（接管等用户交回后自动续跑、拟人间歇、平台风控跳过、每日上限、侧车重启续跑）。命令经 kv `apply:batch:command` 下发；进度在「浏览器现场」页实时可见 |
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
