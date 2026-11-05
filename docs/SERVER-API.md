# 服务端接口契约（共享岗位库 + 答案改动回传 + 邮箱连接器）

客户端（桌面产品）只通过下面的 HTTP 接口访问服务端，**不直连数据库**。服务端用 PostgreSQL 实现，存储方案由后端团队决定；本文只约定接口与身份规则。客户端实现见 `shell/src/server/career/server-api.ts`，岗位契约类型见 `packages/core/src/jobs.ts`。

客户端配置：`设置 → 求职助理 → 服务端`（kv `career:server`：`base_url` + 可选 `token`），环境变量 `CAREER_API_BASE_URL` / `CAREER_API_TOKEN` 兜底。没有配置时，客户端只用本地数据，答案改动在本地累积，配置后自动补传。

## 通用约定

- 鉴权：`Authorization: Bearer <token>`（如需要）。
- 请求与响应都是 `application/json; charset=utf-8`；时间一律 ISO 8601（UTC）。
- 客户端超时 20 秒；非 2xx 视为失败，下次重试，所以写接口必须**幂等**。

## 岗位身份（最重要）

- `job_key` 是岗位在客户端与服务端之间唯一的身份，规则与客户端 `jobKey()` 一致：
  - 有原站岗位号：`<platform>:<原站岗位号>`（platform 小写，如 `moka:12345`、`campus:9f3a…`）；
  - 只有网址：`url:<规范化网址的 sha256 前 16 位>`（去掉 `#`、`utm_*` / `spm` / `from` / `source` / `ref` / `share` / `trace` 参数，去 `www.`，主机名小写，去掉末尾 `/`，其余参数排序）；
  - 都没有：`hash:<公司|职位|地点（去空白、小写）的 sha256 前 16 位>`。
- `job_key` 一经发出**永不复用、永不改变**。服务端去重时把被合并的岗位标 `status: "merged"` 并给出 `merged_into`；下架标 `status: "closed"`。不要物理删除——用户本地的投递记录引用着它。
- JD 内容有实质变化时 `version` +1。客户端只在 `version` 更大时覆盖本地（本地投递用的 JD 已冻结在材料包里，不受影响）。

## GET /v1/jobs

查询岗位（校招 / 实习网申汇总的共享数据）。

查询参数（都可选）：

| 参数 | 说明 |
|---|---|
| `q` | 公司 / 岗位 / 地点关键词 |
| `employment_type` | `campus` / `intern` / `social` |
| `city` | 城市（包含匹配） |
| `cohort` | 届别，如 `2027届` |
| `deadline_after` | `YYYY-MM-DD`，只要截止日期在这之后的 |
| `updated_since` | ISO 时间，增量同步：只要这之后新增 / 更新 / 下架 / 合并的（必须包含状态变化） |
| `cursor` / `limit` | 翻页；`limit` 缺省 200，最大 500 |

响应：

```json
{
  "items": [
    {
      "job_key": "moka:12345",
      "remote_id": "srv-uuid",
      "source_platform": "moka",
      "source_job_id": "12345",
      "url": "https://app.mokahr.com/…",
      "apply_email": null,
      "company_name": "某公司",
      "title": "数据分析实习生",
      "location": "上海/北京",
      "employment_type": "intern",
      "cohort": "2027届",
      "salary": null,
      "jd_raw": "岗位职责……任职要求……",
      "deadline": "2026-11-30",
      "deadline_verified_at": "2026-10-08T03:00:00Z",
      "version": 3,
      "updated_at": "2026-10-08T03:00:00Z",
      "status": "open",
      "merged_into": null
    }
  ],
  "next_cursor": "opaque-string-or-null"
}
```

- `employment_type` 取值 `campus | intern | social | unknown`；`cohort` 统一写成 `20xx届`。
- `deadline_verified_at`：截止日期在官方页面核对过的时间；没核对过给 `null`（客户端会标"未核实"）。
- 客户端按 `updated_since` 增量拉取（记录上次同步时间），最多翻 20 页。
- `apply_email`（可选，字符串或 `null`）：岗位描述明写「简历发送至 xx@xx.com」的投递邮箱。只在原文明确写了投递邮箱时给；「联系我们」「咨询邮箱」「公司邮箱」这类不是投递邮箱，不要填。客户端收到合法邮箱就把岗位走邮件投递；没给时客户端会按 `jd_raw` 再认一次。
- 入库条件（2026-11-05 起）：写明了怎么投——有网申链接 `url`，**或**有投递邮箱（`apply_email`，或 `jd_raw` 里明写了投递邮箱）。只有投递邮箱、没有 `url` 的条目照常下发，`url` 给 `null`；`job_key` 按上面的规则（这类条目多半走「有原站岗位号」或 `hash:`），不依赖 `url`。两样都没有的条目客户端岗位库不显示（已有投递的照常显示）。

## POST /v1/answer-events

回传用户对网申答案的改动，用于迭代答案质量（产品决策 2026-10-09）。

请求：

```json
{
  "events": [
    {
      "id": "aev_xxxxxxxxxxxx",
      "kind": "edited",
      "question_key": "期望工作城市",
      "question_text": "期望工作城市",
      "answer": "上海",
      "previous_value": "北京",
      "source": "page_edit",
      "sensitivity": "normal",
      "job_key": "moka:12345",
      "site_host": "app.mokahr.com",
      "created_at": "2026-10-09T12:00:00Z"
    }
  ]
}
```

- `kind`：`answered`（第一次回答）/ `edited`（用户改了答案库）/ `corrected`（提交前用户在页面上改了产品填的值，或接管时自己填的）/ `archived` / `deleted`。
- `source`：`user` / `learned` / `page_edit` / `import`。
- 隐私边界（客户端已保证，服务端不要依赖客户端之外的假设）：
  - 证件号、密码、验证码、"是否使用 AI 作答"、反机器人题（`excluded`）**从不上传**；
  - 个人信息（`personal`）与自我认同类（`self_id`，性别 / 民族 / 政治面貌等）只上传"有改动"，`answer` 与 `previous_value` 为 `null`；
  - 不上传本地投递 id；`answer` 里的私密信息仍是占位符（`{{vault:profile.phone}}`），不是明文。
- 幂等：按 `id` 去重，重复提交返回 2xx。
- 响应：任意 2xx（建议 `{ "accepted": n }`）。

## 邮箱连接器（/v1/connectors、/v1/connections、/v1/mail）

用户在桌面端连接自己的个人邮箱（QQ / 163 / 126 / Gmail），服务端是连接的**唯一事实源**：保存加密后的授权码，负责 IMAP 收信、保活与健康探测，把新邮件以事件流交给客户端；客户端只存投影，邮件的识别与接管（规则 + 模型）在客户端做。产品决策 2026-10-30：凭证上云。

客户端实现：`shell/src/server/career/mail/remote.ts`（客户端无服务端配置时退回本机实现，见 `mail/backend.ts`）。

### 身份与鉴权

- 连接归属于 `Authorization` 里的用户。所有 `/v1/connections/*` 只能看到、操作自己的连接，越权返回 404。
- `connection_id` 由服务端生成，一经发出不变、不复用。客户端拿它当本地邮件记录的外键。

### 数据（服务端自定，下面是参考结构）

```sql
connections (
  id uuid PK, user_id uuid,
  provider text,                -- qq | 163 | 126 | gmail
  auth_type text,               -- credential_form | oauth（oauth 轨预留）
  email_address text,           -- 小写；同一用户下唯一
  status text,                  -- active | expired | revoked
  credential_ciphertext bytea,  -- 信封加密（见下）
  imap_host, imap_port, smtp_host, smtp_port,
  uidvalidity bigint, sync_cursor_uid bigint,
  consecutive_fails int, last_check_at, last_ok_at, last_used_at,
  created_at, updated_at
)
connection_audit (id, connection_id, actor /* agent|user|system */, operation, status /* ok|failed */, detail jsonb, latency_ms, created_at)
mail_events (id bigserial, connection_id, uid, message_id, in_reply_to, from_addr, to_addr, subject, received_at, backfill bool, body text, created_at)
oauth_sessions (state PK, user_id, provider, code_verifier, expires_at)   -- 预留
```

- **凭证加密**：信封加密。每次写入随机生成数据密钥加密授权码，数据密钥由主密钥包裹，与密文同存 `{kid, wrapped_dek, nonce, ciphertext}`。主密钥双槽轮换：写入用当前槽；读到旧槽的记录后台惰性重加密。授权码明文只在服务端内存里用于登录，不进日志、不回传客户端。
- 解绑即删凭证（`credential_ciphertext` 置空、`status=revoked`）；事件与留痕按保留期清理。

### 连接状态机

```
(无) ──verify ok──> active ──连续 3 次认证失败──> expired ──reauthorize ok──> active
                      └── DELETE ──> revoked
```

- 判定 `expired`：IMAP 认证类失败（授权码错 / IMAP 被关）**连续 3 次**；网络错误只累加 `consecutive_fails`，不改状态。
- `expired` 后**停止自动登录**（防止服务商因反复错误登录锁号），等用户重新授权。

### GET /v1/connectors

连接器目录。引导、字段、官方页面都由服务端下发，新增邮箱服务商不用发客户端版本。客户端拿不到时用内置的同一份数据（`mail/connectors.ts`）。

```json
{ "connectors": [
  { "id": "qq", "name": "QQ 邮箱", "auth_type": "credential_form", "capabilities": ["receive", "send"],
    "open_url": "https://wx.mail.qq.com/", "open_label": "打开 QQ 邮箱", "help_url": "https://service.mail.qq.com/detail/0/75",
    "guide": [{ "title": "开启服务并生成授权码", "text": "…", "path": ["设置", "账号与安全", "安全设置", "POP3/IMAP/SMTP 服务", "生成授权码"] }],
    "verify_note": "生成授权码时，QQ 邮箱会要你用微信扫码或发一条短信验证。",
    "fields": [{ "key": "email", "type": "email", "label": "邮箱地址", "placeholder": "you@qq.com" },
               { "key": "authCode", "type": "secret", "label": "授权码", "placeholder": "16 位字母", "helper": "…", "length": 16 }],
    "oauth": { "enabled": false } }
] }
```

`oauth.enabled` 为 `true` 时客户端走 OAuth 轨（见下）。Gmail 在谷歌受限范围审核通过前保持 `false`。

### POST /v1/connectors/{id}/credentials/verify

请求：`{ "email": "me@qq.com", "authCode": "abcdefghijklmnop", "reauthorize": false }`（`authCode` 已去空格）。

服务端真连校验：IMAP LOGIN → SELECT INBOX（记下 UIDVALIDITY）→ SMTP AUTH，总时限 15 秒。只有收信通过才保存；发信失败也算连上，`smtp_ok: false`。

成功：`{ "ok": true, "smtp_ok": true, "connection": Connection }`，并开始历史回填（见事件流）。

失败（HTTP 200，失败是业务结果）：`{ "ok": false, "error_code": "...", "message": "给用户看的一句话", "connection_id": "..."? }`

| error_code | 何时 | 客户端怎么引导 |
|---|---|---|
| `imap_auth_failed` | 授权码错或已失效 | 重新填写 / 查看教程 |
| `imap_disabled` | 邮箱没开 IMAP | 打开设置教程 |
| `provider_blocked` | 服务商风控（如网易 Unsafe Login） | 稍后重试 / 查看教程 |
| `unreachable` | 网络或超时 | 重试 |
| `duplicate` | 该地址已有 active 连接且 `reauthorize=false`；带 `connection_id` | 查看连接 |
| `invalid_input` | 地址或授权码格式不对 | 重新填写 |

`reauthorize=true` 时覆盖凭证、清零 `consecutive_fails`、状态回 `active`，保留同步游标。

### GET /v1/connections · GET /v1/connections/{id} · DELETE /v1/connections/{id}

```json
{ "connections": [ {
  "id": "conn_…", "provider": "qq", "auth_type": "credential_form", "email_address": "me@qq.com",
  "status": "active", "health": { "status": "healthy|degraded|expired", "last_check_at": "…", "last_ok_at": "…", "consecutive_fails": 0, "last_error": null },
  "created_at": "…", "last_used_at": "…", "last_sync_at": "…"
} ] }
```

`DELETE` 幂等，删凭证并停止同步。

### GET /v1/connections/{id}/usage?days=7 · GET /v1/connections/{id}/audit?limit=20

- `usage`：`{ "days": 7, "by_op": { "import": { "ok": 1, "failed": 0 }, "sync": {…}, "send": {…} } }`
- `audit`：`{ "entries": [{ "id", "actor": "agent|user|system", "operation": "connect|reauthorize|import|sync|send|health_check", "status": "ok|failed", "detail": {…}, "latency_ms", "created_at" }] }`
- 代发必须留痕：`detail` 至少有 `to`、`subject_preview`（前 20 字）、`trigger`（客户端动作 id）。空同步（没拉到信）不留痕。

### POST /v1/connections/{id}/sync

用户点「立即同步」。服务端立刻跑一次增量，返回 `{ "fetched": n }`；新邮件照常进事件流。`expired` 返回 `{ "error_code": "expired" }`。

### 收信与保活（服务端内部行为）

- **历史回填**：连接成功后回看 180 天。先只拉信头，用求职粗筛（主题 / 发件人命中招聘关键词或招聘系统域名，规则与客户端 `isLikelyJobMail` 一致）只保留命中的，最多 1000 封，拉正文后以 `backfill: true` 进事件流。无关邮件不入库。
- **新邮件**：IMAP IDLE 优先，每 9 分钟 DONE 重挂；不可用时每 15 分钟按 `sync_cursor_uid` 增量拉。新邮件同样过求职粗筛，命中的进事件流（`backfill: false`）。
- **UIDVALIDITY** 变了：游标作废，按历史回填重来（客户端按 `message_id` 去重）。
- **健康**：每次登录即一次探测，更新 `last_check_at / last_ok_at / consecutive_fails`；另每 30 分钟对无 IDLE 的连接做 LOGIN + SELECT 探测。
- 单连接串行（IMAP 不适合并发），发信用独立的 SMTP 短连接。

### GET /v1/mail/events?since=<cursor>&limit=200

客户端每分钟拉一次，按 `cursor` 增量。

```json
{ "events": [ {
  "id": "evt_…", "connection_id": "conn_…", "uid": 1234, "message_id": "<…>", "in_reply_to": null,
  "from": "美团校园招聘 <noreply@mokahr.com>", "to": "me@qq.com", "subject": "【美团】已收到您的简历",
  "received_at": "2026-08-20T02:00:00Z", "backfill": true, "text": "正文纯文本（最多 20000 字）"
} ], "next_cursor": "…" }
```

- 只放求职粗筛命中的邮件，所以正文直接带上（`text`）；客户端不再单独取正文。
- 至少一次投递：客户端按 `(connection_id, message_id)` 去重。`next_cursor` 为空表示暂时拉完。
- 客户端处理：`backfill: true` 走历史模式（规则先认，认得出的直接接管成申请、不进通知中心；只有近两周可能还没发生的事才调模型）；`false` 走正常归档。

### POST /v1/mail/send

代发经用户批准的投递邮件。请求：

```json
{ "connection_id": "conn_…", "to": "hr@x.com", "cc": null, "subject": "应聘产品经理 - 张三", "body": "纯文本",
  "attachments": [{ "filename": "张三-简历.pdf", "content_base64": "…", "sha256": "…" }], "trigger": "act_…",
  "in_reply_to": null, "references": [] }
```

- `in_reply_to` / `references`（2026-11-05 邮件投递阶段二新增，可空）：跟进与回信接在原信下面，服务端照原样写进 `In-Reply-To` / `References` 头。云端未实现前忽略这两项也不报错（信照发，只是对方邮箱里不归进同一会话）。

- 附件总大小上限 10 MB；`sha256` 与内容不符返回 400。
- 幂等：按 `trigger` 去重（同一个客户端动作只发一次），重复请求返回第一次的结果。
- 成功：`{ "message_id": "<…>" }`。失败：`{ "error_code": "expired|smtp_failed|rate_limited", "message": "…" }`（HTTP 200）。
- 风控：单连接默认 10 封/分钟、200 封/天；连续触发服务商限流熔断 30 分钟。

### OAuth 轨（预留，Gmail 过审后启用）

- `POST /v1/connectors/{id}/oauth/start` → `{ "authorize_url": "https://accounts.google.com/…", "state": "…" }`。客户端在用户浏览器打开 `authorize_url`。
- 服务端回调 `/v1/oauth/callback?state=&code=`：PKCE 换 token，refresh_token 按凭证同样信封加密，建连接（`auth_type: "oauth"`），之后与授权码连接走同一套收信、事件、发信。
- 客户端轮询 `GET /v1/connectors/{id}/oauth/status?state=` → `{ "status": "pending|done|failed", "connection": Connection? }`。
- 未启用时 `start` 返回 `{ "error_code": "oauth_not_enabled" }`（HTTP 200），客户端显示「审核后开放」。
- 读信 scope 用 `gmail.readonly`（发信加 `gmail.send`），都属谷歌受限范围：需品牌验证、受限范围审核，按谷歌要求做年度安全评估。


## 计费（预留，账号上线后启用）

现在积分账本只在本机（`packages/core/src/billing/`，计费清单与埋点见 `docs/BILLING.md`）。账号上线后云端是余额的唯一权威，客户端只报用量、不报金额（价目由云端说了算，同 Star AI 桌面端「方案 A」）。

- `POST /v1/billing/usage`：一批用量。body `{ items: [{ idempotency_key, scope, origin, kind: 'llm'|'tool'|'asr', name, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, quantity, created_at }] }`，字段与本机 `billing_usage` 表同构，幂等键原样沿用（`chat:<会话>:<结果 uuid>`、`llm:<uuid>`、`tool:<工具>:<uuid>`…）。响应 `{ credits_charged, balance, unpriced: string[] }`；撞幂等键的条目不再扣。余额不足部分扣减、不返 402，由 `balance` 决定客户端是否拦下一轮。
- `POST /v1/billing/events`：一批场景卖点。body `{ items: [{ idempotency_key, event, quantity, ref_type, ref_id, created_at }] }`，同本机 `billing_event`；按件计价定下来后由云端按 `event` 扣积分或扣套餐件数。
- `GET /v1/billing/account`：`{ tier, credits, subscription_credits, subscription_expires_at }`。
- `GET /v1/billing/transactions?limit=&before=`：流水，字段同本机 `credit_transaction`。
- `GET /v1/billing/price-list`：结构同本机 `buildPriceList()`，带 `anchor`（`[pricing] version=N`），客户端启动时比对，不一致打告警。
- `POST /v1/billing/checkin`、充值 / 套餐下单与支付回调：随支付方案再定。

## 后续（尚未使用）

- `GET /v1/questions`（公共题库）：题目实体与客户端 `question` 表同构（见 ARCHITECTURE.md 题库一节），身份用 `question_key`（规范化题干哈希）。
