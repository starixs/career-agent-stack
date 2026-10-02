# @career/apply

网申表单引擎 + Boss 打招呼策略 + 国内站适配器。只依赖 `@career/core`（Repos / LLM / 状态枚举）和 `playwright-core` 的 `Page` 类型；不启动浏览器，不自动提交、不自动发送。

## 怎么用
```ts
import { fromPlaywright, ApplyService, diagnosePage, GreetingScheduler, composeGreeting, RiskGuard } from '@career/apply'
const page = fromPlaywright(pwPage)                       // 浏览器由 shell 的 browser-host 托管
const diag = await diagnosePage(page, { url })             // 预检：可达 / 需登录 / 字段数 / 文件上传 / 反爬提示
const svc = new ApplyService(repos, llm)
const out = await svc.run(page, applicationId, svc.buildProfile('/path/简历.pdf'))
// out.result.status ∈ stopped_before_submit | handoff | blocked | failed
// 停在提交前 → action_queue 里多一条 kind=submit, status=pending_review，用户批准后才由执行层点击
const sched = new GreetingScheduler(repos)                 // 时间窗 9-12/14-18、每日 30 条、随机间隔、风险锁
if (sched.canSendNow().ok) { const { text, selfReview } = await composeGreeting(llm, { job, resumeSummary }) }
```
流程：每页 `extractFields`（页面内纯 DOM 脚本）→ `interpretForm`（基本信息直填；高影响题只用答案库原话否则 `needs_user`；开放题起草 `draft_needs_confirm`）→ 先上传简历并检查回显 → 批量填写 → 重新抽取做差异核对、只修差异 → 找"下一步"。命中 `SUBMIT_RX` 一律停止并截图；验证码 / 登录墙 / 滑块 / 2FA / 测评 → `handoff`，并写入 kv 风险锁（`RiskGuard`，与打招呼共用）。

## 私密信息库（`@career/core` 的 `Vault`）
`new ApplyService(repos, llm, { vault })` 后：
- `buildProfile()` 的 basics 来自私密库（明文只在 Node 侧）；
- 计划值里的 `{{vault:profile.phone}}` 等占位符在填写前解成明文（`DriveOptions.resolveValue`），模型起草的草稿里只会出现占位符（`interpretForm` 不再把姓名送进提示词）；
- 登录墙：站点账号开了 `autofill` 时用 `fillLoginForm` 代填账号 / 密码输入框（`login.ts`，纯关键词匹配，不点登录、不碰验证码），然后仍然 `handoff(login)`；
- 落库（`action_queue.result_json` / `answers_used_json`）与返回的 `summary` 全部 `redactDeep`：明文换回占位符。`result` 保留原始值，不要直接回传模型。

## 测试
`FakePage` 是内存 DOM 模型：预置多页字段与按钮（`goto` 跳转、`submit` 标记）、验证码 / 登录墙、上传回显与解析自动填充，记录所有动作；`pnpm vitest run packages/apply`。

## 未实测
- `scripts.ts` 里的 DOM 脚本与 `fromPlaywright` 只能在真实浏览器里验证，单测走的是 FakePage。
- `adapters/`（北森 / Moka / 飞书 / 牛客 / Boss）的按钮文案、登录与风控指示词、字段别名均按公开页面结构尽力编写，**未在真实登录态下验证**。
- 自定义下拉（antd / element）的"点击 + 输入 + 回车"填法未在真实站点验证。
