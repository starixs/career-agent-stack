# @career/bridges

把 Python 模块与外部数据源接成 TypeScript 可调用的服务。只通过子进程 / 本地 HTTP 调用，不改模块源码；路径与端口全部从环境变量读。

| 桥接 | 做什么 | 依赖怎么启动 | 环境变量 |
|---|---|---|---|
| `trident.ts` | `TridentClient`（岗位列表 / 触发采集 / 评分追踪 / 状态 / manual-sent 回填）、`TridentProcess`（子进程起 web 服务并等 `/api/health`）、`importJobs(repos, jobs)` 写 `job` 表 | `cd modules/trident-scanner && uv run trident-scanner web --no-open`（前端需先 `npm ci && npm run build`） | `TRIDENT_BASE_URL`（默认 `http://127.0.0.1:8686`）、`TRIDENT_DIR`（默认 `modules/trident-scanner`）、`TRIDENT_RUNNER=uv\|python`、`TRIDENT_CMD`（完全自定义命令）、`TRIDENT_CONFIG`、`UV_BIN`、`PYTHON_BIN` |
| `docparse.ts` | `parseDocument(path, {to, ocrLang, pipeline})` → `{markdown, json}`；`extractPdfLinks(path)` 用 pdf-lib 读 PDF 链接注解（失败退化为正则扫描 `/URI`） | `pip install docparse`（或 `pip install -e modules/docparse[cli]`） | `DOCPARSE_BIN`（默认 `docparse`） |
| `repoMiner.ts` | 纯 TS：`mineRepo(repoPath, {author, llm, jd})` 用 git log/shortlog/numstat/blame 统计本人贡献、识别技术栈、让 LLM 产出 `Claim[]` 并在代码里强制真实性规则；`importMineResult(repos, experienceId, result)` 写 claim/evidence（status 一律 pending） | 只需要 `git` | 无 |
| `intelCompass.ts` | `IntelCompassClient.research(name)` → 九段 `DdReport`；`IntelCompassProcess` 起 Flask；`saveReport(repos, name, report)` 写 `company` 表（dd_report_json / traffic_light / manual_checks）并关联同名岗位 | `cd modules/intel-compass && DD_BRAND_MAP=$PWD/brand_map.json python3 -m web.app --port 8765`（需 `pip install -r scripts/requirements.txt flask`） | `INTEL_COMPASS_BASE_URL`（默认 `http://127.0.0.1:8765`）、`INTEL_COMPASS_DIR`、`DD_BRAND_MAP`（Process 会自动设成模块根目录的 brand_map.json）、`PYTHON_BIN` |
| `webSearch.ts` | `SearchProvider` 接口；`BochaSearch` / `TavilySearch` / `SerperSearch`；`createSearchProvider()` 按环境变量选 | 无 | `SEARCH_PROVIDER=bocha\|tavily\|serper` + `SEARCH_API_KEY`（或 `BOCHA_API_KEY` / `TAVILY_API_KEY` / `SERPER_API_KEY`） |
| `campusRadar.ts` | `loadCampusJobs()` 读 jobs.json；`filterCampusJobs(items, {industry, keyword, deadlineWithinDays})`；`importCampusJobs(repos, items)`（`source_platform='campus'`，`deadline_verified_at` 为 null） | 静态文件 | `CAMPUS_RADAR_JOBS` / `CAMPUS_RADAR_DIR`（默认 `modules/campus-radar/jobs.json`） |

## 用法

```ts
import { TridentProcess, syncTridentJobs, mineRepo, importMineResult, IntelCompassClient, saveReport, createSearchProvider, loadCampusJobs, filterCampusJobs, importCampusJobs, parseDocument, extractPdfLinks } from '@career/bridges'

const proc = new TridentProcess(); await proc.start()           // 已在跑则直接复用
const jobs = await syncTridentJobs(proc.client(), repos, { withTrace: true })
await proc.stop()

const result = await mineRepo('/path/to/repo', { author: 'me@example.com', llm, jd })
importMineResult(repos, experienceId, result)                   // claim 全部 pending，等用户确认

const report = await new IntelCompassClient().research('某某科技')
saveReport(repos, '某某科技', report)                             // traffic_light = report.summary.light

const hits = await createSearchProvider().search('某某科技 拖欠工资', { count: 10 })
importCampusJobs(repos, filterCampusJobs(loadCampusJobs(), { deadlineWithinDays: 14 }))
const { markdown } = await parseDocument('/path/简历.pdf', { to: ['md', 'json'], ocrLang: 'zh' })
const links = await extractPdfLinks('/path/简历.pdf')
```

## 测试

`pnpm vitest run packages/bridges`：全部不依赖网络与 Python（fetch / 子进程 mock，临时 git 仓库，真实 jobs.json，pdf-lib 现场生成 PDF）。

## 未实测项（需要真实环境）

- `TridentProcess` / `IntelCompassProcess` 真正拉起 Python 服务（只测了命令构造）。trident-scanner 源码包目录名含连字符（`src/trident-scanner`），`python -m trident-scanner.main` 路径大概率不可用，请用 `uv run` 或 `TRIDENT_CMD` 指到已安装的可执行文件。
- 对 trident 真实服务的 `/api/jobs/search` 返回形态（代码同时兼容数组与 `{items,total}`）。
- `parseDocument` 对真实 docparse 的 OCR 语言标签：默认原样传 `zh`，rapidocr 需要 `ch`，或用 `iso:zh-Hans`。
- 博查 / Tavily / Serper 的真实响应字段（按各自公开文档映射）。
- intel-compass 真实报告字段的完整性（归一化用了宽松 schema，缺段落不报错）。
