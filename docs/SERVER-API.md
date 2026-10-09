# 服务端接口契约（共享岗位库 + 答案改动回传）

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

## 后续（尚未使用）

- `GET /v1/questions`（公共题库）：题目实体与客户端 `question` 表同构（见 ARCHITECTURE.md 题库一节），身份用 `question_key`（规范化题干哈希）。
