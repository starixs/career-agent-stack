# 产品架构契约（所有包必须遵守）

产品 = `shell/`（keystone 基座的产品分支）+ `packages/*`（求职领域库）+ `skills/`（提示词技能包）。

## 产品决策（已定，不再讨论）
1. **单一对话**：只有一个"个人助理"对话区，没有多会话 / 工作区 / 多 Tab。一级入口固定为：对话、经历库、简历、岗位与投递、调研、面试、Offer。
2. **所有功能在产品内完成**；LLM 唯一的外部动作是 Web Search。
3. **内置国内模型，零配置**：OpenAI 兼容接口，默认 DeepSeek（可在打包时切换 Qwen / 豆包 / Kimi / GLM）。用户端没有任何模型设置项。
4. **反检测进产品**（"像真人用自己的浏览器"）：真实 Chrome 持久 profile、去自动化标志、拟人节奏、限速与风险锁、被动捕获不注入请求。验证码 / 登录 / 2FA / 需本人作答的测评 / 最终提交 一律交给用户本人。
5. **提交与发送永远过人**：`submit` / `send_greeting` / `answer_open_q` 三类动作只能从待审核队列被用户批准后执行（`@career/core` 的 `ACTIONS_REQUIRING_REVIEW`）。
6. **不编造**：经历库里的主张默认 `pending`，只有用户确认或有强证据才能进简历；缺数据标"未知"。
7. **私密信息不进模型**（`@career/core` 的 `Vault`）：真实姓名 / 手机 / 邮箱 / 证件号 / 住址、投递网站账号密码、经历的保密细节只在「私密信息」页由用户填写，AES-256-GCM 加密落 SQLite（密钥 `CAREER_DATA_DIR/vault.key`，0600）。模型侧只有 `vault_status`（字段名 + 脱敏预览），文本里用占位符 `{{vault:profile.phone}}` / `{{vault:exp.<经历id>.<字段>}}` 指代。两个 hook：**出口**（填表 / 登录代填 / 导出简历时在 Node 侧 `resolve` 成明文并写访问日志）与**入口**（所有 career 工具结果回传前 `redact` 把明文换回占位符）。登录代填只填账号密码输入框、不点登录，仍遵守第 4 条。
8. **浏览器执行分层**（`@career/apply` 的 `driveApplication`）：L1 DOM 直驱（抽字段 → 规划 → 填写 → 读回核对）；L2 视觉兜底（DOM 抽不到字段 / 填不进去 / 找不到按钮时：截图 → `Perceiver`（DOM 盒子 + macOS Vision OCR，按标签位置合成输入框；可选视觉模型做分类）→ 坐标点击 + 键盘输入，按钮文案做 OCR 容错）；L3 交给用户（`describeObstacle` 说清要做什么：滑块 / 点选 / 短信码 / 图形码 / 浏览器检查，登录可先代填）。感知器只回答"哪里有什么"，点哪里填什么永远是确定性代码，提交类按钮任何一层都不点。风控：限流提示 / 跳转到验证页 → 风险锁按当天次数渐进退避（30 分钟 → 2 小时 → 12 小时 → 24 小时）。重复分区（教育 / 实习 / 项目"表格"）：按锚字段切行、逐行填、不够就点"添加"只填新出现的那一行。接管交还后由 `apply_continue` 从当前页继续。真实 Chrome 冒烟：`shell/scripts/career-browser-smoke.mjs`（不依赖 Tauri 能力令牌）。

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
