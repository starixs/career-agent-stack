# 中国求职 Agent 工作台

产品 = `shell/`（keystone 基座的产品分支）+ `packages/*`（求职领域库）+ `skills/`（内置技能包）。
架构契约见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)，接口契约见 [docs/API.md](./docs/API.md)，落地计划见 [../产品落地计划.md](../产品落地计划.md)。

## 目录

```
app/
├─ shell/                 keystone 产品分支（Tauri + React + Node 侧车，npm）
│  ├─ src/server/career/     数据库单例、ShellLLM、run 状态机、技能加载、导出、搜索
│  ├─ src/server/routes/     career.ts / career-session.ts / career-browser.ts
│  ├─ src/server/tools/career-tools.ts   26 个常驻工具（Pattern 1 注入，用户不可关）
│  ├─ src/server/browser-host/           真实 Chrome 持久 profile、去自动化标志、接管锁、窗口前置
│  ├─ src/renderer/pages/Career*.tsx     六个一级功能页
│  ├─ src/renderer/components/career/    看板、审核卡片、浏览器状态条
│  └─ bundled-workspaces/career/         固定工作区模板（.claude/skills 由脚本同步）
├─ packages/              pnpm 工作区，TypeScript，vitest
│  ├─ core/      统一 SQLite 数据层、状态机、动作队列、接管表、技能加载器、LLM 接口
│  ├─ resume/    简历 schema、JD 解析、tailor（JSON Patch + 编造检测）、PDF/DOCX/PNG 渲染
│  ├─ apply/     网申表单引擎（永不提交）、国内站适配器、Boss 招呼语节奏、风险锁、拟人节奏
│  └─ bridges/   trident-scanner / docparse / intel-compass 桥接、repo 证据挖掘、Web Search、校招数据
├─ skills/                22 个技能包（SKILL.md + references）
└─ docs/
```

## 开发

```bash
# 1. 领域库
cd app && pnpm install && pnpm -r build && pnpm test        # 122 个测试

# 2. 壳（keystone 分支，npm；Node ≥ 24，本机 Node 26 需要下面的 NODE_OPTIONS）
cd app/shell && SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install  # postinstall 会把 @career/* 软链进 node_modules
npm run typecheck
NODE_OPTIONS=--no-experimental-webstorage npm run test:unit
NODE_OPTIONS=--no-experimental-webstorage npm run test:dom

# 3. 只起 Node 侧车 + Web 前端（不走 Tauri；托管浏览器与接管需要 Tauri）
npm run dev

# 4. 完整桌面开发（需要 Rust 工具链与 cmake；一键脚本会自检并补齐 bundled Node / tsx / sharp / Claude SDK / CLI 资源）
CAREER_LLM_API_KEY=sk-... ./start_desktop.sh
# 不要用 npm run tauri:dev：它会先跑 CLIProxy 与语音模型的下载脚本，产品不需要且其下载源不可达
```

## 构建期注入（零配置的来源）

| 环境变量 | 作用 | 缺省 |
|---|---|---|
| `CAREER_LLM_API_KEY` | 内置模型 key（只进侧车 bundle，不进前端） | 空（模型不可用） |
| `CAREER_LLM_BASE_URL` | DeepSeek 的 Anthropic 兼容入口（壳与 SDK 都在其后拼 `/v1/messages`，`Authorization: Bearer` 鉴权） | `https://api.deepseek.com/anthropic` |
| `CAREER_LLM_MODEL` | 模型名；`deepseek-flash` 支持图片输入，`deepseek-chat` 为纯文本 | `deepseek-flash` |
| `CAREER_SEARCH_PROVIDER` / `CAREER_SEARCH_API_KEY` | Web Search（bocha / tavily / serper） | 空（搜索不可用） |

运行期：`CAREER_DATA_DIR`（数据库与导出目录，缺省 `~/.keystone/career/`）、`CAREER_SKILLS_DIR`（缺省自动定位 `app/skills`）、`CAREER_BROWSER_PERSISTENT=0`（回退旧浏览器模式）、`CAREER_BROWSER_CHANNEL=chrome|chromium`。

## 发布注意

- 侧车 esbuild 把 `@career/*` 设为 external：发布包需随 Resources 携带 `packages/*`（含各自 pnpm node_modules），否则 `/api/career/*` 返回 503，`career` 工具集被跳过。
- `scripts/sync-career-skills.mjs` 在 `dev:web` / `build:web` 前自动把 `skills/` 同步进固定工作区模板。
- 五个国内网申站适配器与 Boss 被动采集 **未在真实登录态下验证**，需逐站实测。
