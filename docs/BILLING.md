# 计费：积分账本、计费清单与埋点

口径照 Star AI（`star_ai/apps/backend/app/core/pricing.py`、`pricing_config.py`、`services/billing.py`、`api/routes/desktop_billing.py`，origin/main 2026-10-08）。代码在 `packages/core/src/billing/`，界面在「设置 → 账号与用量」。

**现状：只在本机记账，不拦用户。** 还没有账号和充值，余额到 0 也照常用；账号上线后改为上报云端、以云端为准（契约见 `SERVER-API.md`「计费」）。

## 1. 计费清单

单价的唯一来源是 `pricing.ts` + `catalog.ts`；界面和云端对表都读 `buildPriceList()`，这里只是说明。

| 项 | 价格 | 来由 |
|---|---|---|
| 积分面值 | 1 元 = 5 积分（1 积分 = ¥0.2） | 同 Star AI |
| 内置模型 DeepSeek V4 Flash | 成本价 输入 5 / 输出 10 / 缓存命中 0.1 积分每百万 token，× 毛利 7 = **35 / 70 / 0.7** | DeepSeek 官价 ¥1 / ¥2 / ¥0.02 × 5；毛利同 Star AI |
| DeepSeek V4 Pro（未开放） | 15 / 30 / 0.125 × 7 | 先登记 |
| 没登记的模型 | 兜底 5 / 20 / 1.25 × 7，并打 `[billing] UNPRICED` | 宁保守不白送 |
| 联网搜索（博查 / Tavily / Serper） | 1 积分 / 次 | 成本都不到 ¥0.2 / 次 |
| 读网页、读附件、导出简历、发邮件、过验证码 | 0（显式登记） | 无外部成本，或成本已在 token 里 |
| 面试录音转写 | 3 分钟内免费，超出整段 0.2 积分 / 分钟，至少 1 | 同 Star AI；识别还没接 |
| 开户赠送 | 50 积分（¥10 面值） | Star AI 注册送 ¥10 面值 |
| 每日签到 | 免费 2 / 会员 5 | 〔推〕草稿 |
| 冲刺月卡 | ¥39 / 月，250 积分 | 〔推〕草稿 |
| 秋招季卡 | ¥99 / 季，900 积分 | 〔推〕草稿 |
| 充值 | ¥10 / 30 / 50 / 100 → 50 / 150 / 250 / 500 积分 | 按面值，无折扣 |

估一下量级（用本机一次真实长会话核对，2026-11-05）：一轮 10.5 万输入、2.8 万输出、180 万缓存命中 ≈ (0.105×5 + 0.028×10 + 1.8×0.1) × 7 ≈ 6.9 积分 ≈ ¥1.4。

## 2. 扣费规则

- 先扣套餐积分（会到期），再扣永久积分；余额不够扣到 0，缺口记在流水 `extra.shortfall`，不打断已经干完的活。
- 每笔有幂等键，重放不重复记。
- 同一 scope（一个会话 / 后台一天）内累计精确成本，`ceil(累计) − 已扣` 才是这次实扣。逐次取整会多收数倍（Star AI 2026-10-05 核对：一周 997 对 201）。
- 失败、中止的轮次照样计：token 已经花出去了。
- 模型 token 过毛利倍数；工具按次是查表整数，不过毛利。

## 3. 埋点清单

所有花钱的地方都落一行 `billing_usage`（0 积分的也落，看得见调了几次）。

| 埋点 | 位置 | 幂等键 / scope | 覆盖 |
|---|---|---|---|
| 主对话每轮 | `shell/src/server/builtin-session/turn-lifecycle.ts`（用量盖章之后） | `chat:<会话>:<SDK 结果 uuid>` / `chat:<会话>` | 小芽对话，含 SDK 子代理与辅助调用 |
| 会话标题 | `shell/src/server/title-generator.ts` | `title:<会话>:<消息 uuid>` | 自动起标题 |
| 后台模型调用 | `shell/src/server/career/llm.ts` `ShellLLM.complete` | `llm:<uuid>` / `background:<本地日期>` | 定制简历、导入简历、岗位评估、公司调研、面试准备、填表引擎、过验证码、笔试搜题、邮件归档、登录寻路、JD 解析等全部 askSkill 与引擎调用 |
| 联网搜索 | `shell/src/server/career/search.ts` `meteredSearch` | `tool:search:<供应商>:<uuid>` | web_search、公司调研、方向探索 |
| 语音转写 | `packages/core/src/billing/meter.ts` `recordAsrUsage` | 调用方给 | 已备好，ASR 接上时调用 |

钩子：`shell/src/server/turn-hooks.ts` 的 `fireUsageMeterHook`（和标题钩子同一种依赖倒置），侧车启动时 `career/billing-service.ts` 的 `installBillingMeter()` 接到本机账本。

日志锚点：`[billing] METERED`（每次落账）、`[billing] UNPRICED`（兜底价 / 没定价）、`[billing] FAILED`（落账失败，按它补账）。

**不在埋点里的**：外部运行时（Claude Code / Codex 等，求职产品不用）、`provider-verify`（填 Key 时的一次验证）。

## 4. 数据

- `credit_account`：本机单账户 `local`，永久积分 + 套餐积分 + 到期时间。
- `credit_transaction`：每笔增减，`(account_id, idempotency_key)` 唯一。
- `billing_usage`：每次调用的 token / 次数 / 精确成本 / 实扣 / 我方成本（微美元）/ 是否定价。

接口：`GET /api/career/billing/summary`、`GET /api/career/billing/transactions`、`GET /api/career/billing/price-list`、`POST /api/career/billing/checkin`。

## 5. 改价

改 `pricing.ts` 的价目或 `catalog.ts` 的模板，同时把 `PRICING_TABLE_ANCHOR` 的 version +1。改积分面值要连 `MODEL_PRICING` 一起改。
