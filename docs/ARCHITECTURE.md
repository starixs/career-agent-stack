# 产品架构契约（所有包必须遵守）

产品 = `shell/`（keystone 基座的产品分支）+ `packages/*`（求职领域库）+ `skills/`（提示词技能包）。

## 产品决策（已定，不再讨论）
1. **单一对话**：只有一个"个人助理"对话区，没有多会话 / 工作区 / 多 Tab。一级入口是围绕时间与状态的五个面 + 指南：**今日、收件箱、卷宗、素材、复盘、指南**（2026-10-03 重构，见《产品落地计划》§11；经历库 / 简历 / 岗位与投递 / 面试 / Offer / 调研降为面内视图）。
2. **所有功能在产品内完成**；LLM 唯一的外部动作是 Web Search。
3. **内置国内模型，零配置**：OpenAI 兼容接口，默认 DeepSeek（可在打包时切换 Qwen / 豆包 / Kimi / GLM）。用户端没有任何模型设置项。
4. **反检测进产品**（"像真人用自己的浏览器"）：真实 Chrome 持久 profile、去自动化标志、拟人节奏、限速与风险锁、被动捕获不注入请求。验证码 / 登录 / 2FA / 需本人作答的测评 / 最终提交 一律交给用户本人。
5. **提交与发送永远过人**：`submit` / `send_greeting` / `answer_open_q` / `send_mail` 四类动作只能从待审核队列被用户批准后执行（`@career/core` 的 `ACTIONS_REQUIRING_REVIEW`）。
6. **不编造**：经历库里的主张默认 `pending`，只有用户确认或有强证据才能进简历；缺数据标"未知"。

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
见 `packages/core/src/db/schema.sql`。状态流转见 `packages/core/src/states.ts`。

## 五个面与闭环（shell 侧契约）
- **面板 → 对话**：面板按钮只能通过 `suggestToChat(text, context)`（`CareerPrimitives.tsx`）把话发进对话，事件 `career:chat-suggest` 由 Chat 订阅并真正 `sendMessage`；`context.refs` 里只放对象 id，由 `buildCareerContextReminder` 变成隐藏的 `<CAREER_CONTEXT>` 块。禁止再做"复制提示词"按钮。
- **对话 → 面板**：写库的工具 / 路由完成后调用 `focus()`（`career/intake.ts`）广播 `career:focus {surface, id, application_id, job_id}`；App 打开对应的面（`features/career-shared/nav.ts` 是面的唯一清单），面内自行订阅同一事件定位对象。
- **模型提案、面板处置**：任何需要用户决定的东西都要落成有状态的对象（待审动作、pending 主张、截止事件、收件箱条目、未确认素材），面板一键处置；模型不要在对话里逐条追问。
- **收件箱是唯一进水口**：粘贴 / 邮件 / 文件都先 `inbox_item`，再由 `captureIntake` 归档；新的来源接到这里，不要另起一套。
- **邮箱**：授权码只存 `$CAREER_DATA_DIR/mail-credentials.json`（0600），不进 SQLite、不进日志、不进对话；轮询只在 Global 侧车跑一份；发送只能由 `executeSendMailAction` 对已批准的 `send_mail` 执行。
