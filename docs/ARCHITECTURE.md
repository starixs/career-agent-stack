# 产品架构契约（所有包必须遵守）

产品 = `shell/`（keystone 基座的产品分支）+ `packages/*`（求职领域库）+ `skills/`（提示词技能包）。

## 产品决策（已定，不再讨论）
1. **单一对话**：只有一个"个人助理"对话区，没有多会话 / 工作区 / 多 Tab。一级入口是围绕时间与状态的五个面 + 指南：**今日、收件箱、卷宗、素材、复盘、指南**（2026-10-03 重构，见《产品落地计划》§11；经历库 / 简历 / 岗位与投递 / 面试 / Offer / 调研降为面内视图）。
2. **所有功能在产品内完成**；LLM 唯一的外部动作是 Web Search。
3. **内置国内模型，零配置**：OpenAI 兼容接口，默认 DeepSeek（可在打包时切换 Qwen / 豆包 / Kimi / GLM）。用户端没有任何模型设置项。
4. **反检测进产品**（"像真人用自己的浏览器"）：真实 Chrome 持久 profile、去自动化标志、拟人节奏、限速与风险锁、被动捕获不注入请求。验证码 / 登录 / 2FA / 需本人作答的测评 / 最终提交 一律交给用户本人。
5. **提交与发送永远过人**：`submit` / `send_greeting` / `answer_open_q` / `send_mail` 四类动作只能从待审核队列被用户批准后执行（`@career/core` 的 `ACTIONS_REQUIRING_REVIEW`）。
6. **不编造**：经历库里的主张默认 `pending`，只有用户确认或有强证据才能进简历；缺数据标"未知"。
7. **私密信息不进模型**（`@career/core` 的 `Vault`）：真实姓名 / 手机 / 邮箱 / 证件号 / 住址、投递网站账号密码、经历的保密细节只在「私密信息」页由用户填写，AES-256-GCM 加密落 SQLite（密钥 `CAREER_DATA_DIR/vault.key`，0600）。模型侧只有 `vault_status`（字段名 + 脱敏预览），文本里用占位符 `{{vault:profile.phone}}` / `{{vault:exp.<经历id>.<字段>}}` 指代。两个 hook：**出口**（填表 / 登录代填 / 导出简历时在 Node 侧 `resolve` 成明文并写访问日志）与**入口**（所有 career 工具结果回传前 `redact` 把明文换回占位符）。登录代填只填账号密码输入框、不点登录，仍遵守第 4 条。
8. **浏览器执行分层**（`@career/apply` 的 `driveApplication`）：L1 DOM 直驱（抽字段 → 规划 → 填写 → 读回核对）；L1.5 页内执行器（借鉴 quillfill：按 UI 框架指纹走 antd / element / iview / layui / 美团 / 饿了么 / Fusion / My97 等下拉与日期控件的"打开 → 等渲染 → 文本匹配 → 点选"，原生控件 React 安全赋值；配字典归一、日期格式推断、几何标签兜底、站点映射记忆、向用户学答案）；L2 视觉兜底（DOM 抽不到字段 / 填不进去 / 找不到按钮时：截图 → `Perceiver`（DOM 盒子 + macOS Vision OCR，按标签位置合成输入框；可选视觉模型做分类）→ 坐标点击 + 键盘输入，按钮文案做 OCR 容错）；L3 交给用户（`describeObstacle` 说清要做什么：滑块 / 点选 / 短信码 / 图形码 / 浏览器检查，登录可先代填）。感知器只回答"哪里有什么"，点哪里填什么永远是确定性代码，提交类按钮任何一层都不点。风控：限流提示 / 跳转到验证页 → 风险锁按当天次数渐进退避（30 分钟 → 2 小时 → 12 小时 → 24 小时）。重复分区（教育 / 实习 / 项目"表格"）：按锚字段切行、逐行填、不够就点"添加"只填新出现的那一行。接管交还后由 `apply_continue` 从当前页继续。真实 Chrome 冒烟：`shell/scripts/career-browser-smoke.mjs`（不依赖 Tauri 能力令牌）。
9. **可视 + 长程**：用户随时能看、能关、后台不停。「浏览器现场」页签（`career-live`）从 Global 侧车拉 CDP screencast 帧（`/api/career/live/stream`，渲染层原生 fetch 直连 Global 端口，因为 Rust 代理不流式），画面只读；「接管」前置真实 Chrome 由本人操作，「交回」关闭等待中的接管让后台继续。批量投递由 Global 后台运行器（`career/batch-runner.ts`）执行：已批准的 fill_form 排队、逐份 drive、遇接管等用户交回自动续跑、两份之间拟人间歇、平台风险锁跳过、每日上限、状态与命令持久化在 kv（侧车重启自动续跑）。Global 事件经内部 `LiveHub` → stream → 渲染层 `CareerLiveBridge` 转发到 eventBus（Global 的 SSE broadcast 没有客户端）。浏览器宿主新增免令牌的 `withProductSession`（仅同进程调用）。
10. **浏览器只在产品里出现**：托管 Chrome 仍是 headed 真实 Chrome（反检测），但默认"内嵌窗口"（`CAREER_BROWSER_WINDOW=window` 退回独立窗口）：启动参数关掉遮挡 / 后台节流，Registry 用 CDP 把每个窗口停到屏幕角落（macOS 会夹回只露一小角）。不用最小化 / 隐藏应用——实测这两种状态下 `Page.captureScreenshot` 会挂住，视觉层就瘫了。用户在聊天旁的现场抽屉（`CareerLiveDrawer`，可全屏）里看和操作：点画面即接管，点击 / 输入 / 滚动经 `/api/career/live/input` 转发；接管不再前置真实窗口。页面弹出的系统选文件框由 Playwright `filechooser` 拦下（`career/file-chooser.ts`），抽屉里出现「选择文件」，内容经 `/api/career/live/file` 交回 `chooser.setFiles`。画面里处理不了的情况（插件弹窗等）用 `/api/career/live/window` 临时显示真实窗口，用完收回。
11. **对话是主场，卡片就地完成**：一级入口只用来看。凡是要用户动手的一步，工具都推 SSE `career:card {sessionId, card:{id, kind, title, data}}`（Session 侧，进 renderer 白名单），TabProvider 按 id 去重存进 `careerCards`，`CareerChatCards` → `CareerFlowCards` 在对话里渲染。卡片种类：`vault_missing`（vault_status 发现缺核心资料）、`needs_user` / `drafts`（apply_run / apply_continue 的填表缺项与开放题草稿）、`site_login`（卡在登录页且私密库没有该站密码）、`claims_confirm`（experience_add）、`resume_diff`（resume_tailor）、`mail_bind`（还没绑定邮箱），外加批量投递进度卡（Global 事件桥的 `career:batch`）。卡片里填的值走产品接口直接落库：资料、账号密码进私密库，答案进答案库（question_key 用表单标签，下次填表命中），邮箱授权码进本机凭据文件。完成后用 `suggestToChat` 发一句"已补齐，请继续"给助理，值本身不进对话。卡片只存在 renderer 内存，重载后由助理再次调用对应工具重新推出。

## 包约定
- 语言 TypeScript，ESM，NodeNext；`tsc -b` 可编译，`vitest` 可测，测试放 `packages/<pkg>/test/*.test.ts`。
- 只依赖 `@career/core` 提供的：`Db` / `Repos`（SQLite 仓储）、状态枚举、`LLM` 接口（`complete({system, messages, json})`）与 `FakeLLM`、`extractJson`、`loadSkill/skillPrompt`。
- **不直接依赖任何模型 SDK**。需要模型就接收一个 `LLM` 实例。
- 中文优先：提示词、错误信息、日志都用中文；输出结构字段用英文。
- 需要浏览器的代码接收 `playwright-core` 的 `Page`，并额外提供一个可被 fake 的 `PageLike` 最小接口用于测试；**不自行启动浏览器**（浏览器由 shell 的 browser-host 托管）。
- Python 模块（trident-scanner / docparse / intel-compass）只通过子进程或本地 HTTP 调用，不改它们的源码；路径与端口从环境变量读（见根目录 `.env.example`）。
- 新增依赖：在包目录 `pnpm add <pkg>`；若遇 lockfile 冲突等几秒重试。
- 每个包的 `src/index.ts` 导出公开 API，并在包根写 `README.md`（200 字内：做什么、怎么用、哪些是未实测的）。

## 数据模型
见 `packages/core/src/db/schema.sql`。状态流转见 `packages/core/src/states.ts`。私密信息库（`vault_item` / `vault_access_log`）与占位符规则见 `packages/core/src/vault.ts`。

## 五个面与闭环（shell 侧契约）
- **面板 → 对话**：面板按钮只能通过 `suggestToChat(text, context)`（`CareerPrimitives.tsx`）把话发进对话，事件 `career:chat-suggest` 由 Chat 订阅并真正 `sendMessage`；`context.refs` 里只放对象 id，由 `buildCareerContextReminder` 变成隐藏的 `<CAREER_CONTEXT>` 块。禁止再做"复制提示词"按钮。
- **对话 → 面板**：写库的工具 / 路由完成后调用 `focus()`（`career/intake.ts`）广播 `career:focus {surface, id, application_id, job_id}`；App 打开对应的面（`features/career-shared/nav.ts` 是面的唯一清单），面内自行订阅同一事件定位对象。
- **模型提案、面板处置**：任何需要用户决定的东西都要落成有状态的对象（待审动作、pending 主张、截止事件、收件箱条目、未确认素材），面板一键处置；模型不要在对话里逐条追问。
- **收件箱是唯一进水口**：粘贴 / 邮件 / 文件都先 `inbox_item`，再由 `captureIntake` 归档；新的来源接到这里，不要另起一套。
- **邮箱**：授权码只存 `$CAREER_DATA_DIR/mail-credentials.json`（0600），不进 SQLite、不进日志、不进对话；轮询只在 Global 侧车跑一份；发送只能由 `executeSendMailAction` 对已批准的 `send_mail` 执行。
