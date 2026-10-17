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

## 分层执行（L1 DOM → L1.5 页内执行器 → L2 视觉 → L3 用户）
- **L1 DOM 直驱**：上面的流程。`FormField.layer === 'dom'`。
- **L1.5 页内执行器**（`scripts.ts` 的 `fillValueScript`，借鉴 quillfill dom-actuator）：Playwright 填不进去的第三方控件在页面里按 UI 框架指纹（`FormField.framework`：antd / element / iview / layui / mtd / kuma / fusion / phoenix / atsx / my97 / angular）走"打开下拉 → 等选项渲染 → 文本匹配 → 模拟点击 → blur"；原生控件走 React 安全赋值（原型链 setter + input / change 事件）；富文本 execCommand insertText。自定义下拉与第三方日期控件先走它，读回不一致时它是第一轮重试。配套：`normalize.ts` 字典归一（学历 / 性别 / 政治面貌 / 婚姻同义词、日期按 placeholder / type 推断 YYYY-MM 等 9 种格式、中英文月份名）与 `matchOption`；抽取脚本新增几何位置的标签兜底（同一行左侧 / 正上方最近的短文本）、稳定 XPath、框架指纹；`memory.ts` 站点映射记忆（name / xpath / 标签三种签名 → 资料键，读回核对通过才记，用户纠正不被覆盖），续跑时 `learnFrom` 把用户自己填好的 needs_user 字段学进答案库。
- **L2 视觉兜底**（`DriveOptions.perceiver` + 页面支持 `mouse`）：三种触发——DOM 抽不到字段（canvas / closed shadow DOM / 跨域 iframe）、DOM 填了读回不一致（吞掉程序化输入的组件）、DOM 找不到下一步 / 提交按钮。做法：截图 → `Perceiver.perceive` 得到带包围盒的元素 → `locateInputForLabel`（标签右侧 / 下方最近的输入框）→ `mouse.click` + 全选删除 + 逐字 `keyboard.type`；按钮用 `locateButton`（文案 OCR 容错 `fuzzyEquals`，一字之差也认）。提交类文案任何一层都不点。每次降级记在 `escalations`，`layersUsed` 说明用到了哪几层。
- 感知器实现（`perceivers.ts`）：`DomBoxPerceiver`（DOM 盒子，零成本）；OCR 感知器在壳里（macOS Vision），只认字，再用 `synthesizeInputsFromLabels` 按标签位置合成输入框；`VlmPerceiver`（视觉模型，给 OCR 编号表做 Set-of-Mark，只做分类 / 补充，需要 `LLM.supportsImages`）；`composePerceivers` 合并去重。
- **L3 交给用户**：`obstacles.ts` 把 handoff 细分（滑块 / 点选 / 短信码 / 图形码 / 浏览器检查，登录是否已代填），`DriveResult.userAction` 是给用户的原话；风控：限流 / 跳转到 verify 页 → `RiskGuard.trip` 按当天次数渐进退避 30 分钟 → 2 小时 → 12 小时 → 24 小时。
- **重复分区**（`sections.ts`）：教育 / 实习工作 / 项目经历按锚字段（学校 / 公司 / 项目名）切行，逐行填 `Profile.education` / `experiences`，不够就点带分区名的"添加"按钮，只填新出现的那一行；`PageRecord.sections` 记录行数与添加次数。

## 两重机制（2026-10 可靠性改造）
- **第一重（做好）**：`blockers.ts` 障碍层——每页开始、上传后、每个分区前、点击被挡 / 超时后扫一遍模态框 / 遮罩 / cookie 横幅：已知规则（"是否解析简历附件" → 否 / 仅上传；cookie → 仅必要；温馨提示 → 我知道了），未知的让模型在按钮里选，点完核验弹窗消失。`fill.ts` 逐字段：滚到正中 + shadow root 高亮框（`widgets.ts` focusField，pointer-events:none，动作后移除）→ elementFromPoint 探测遮挡 → 自定义下拉 点开 → 枚举弹出层选项 → 字典 / 同义匹配（拿不准再问模型）→ 点选 → 读显示值；日期 能输入先输入，否则面板按 年 → 月（→ 日）导航；级联逐级。标签解析排除 fixed / sticky / 导航栏文字、不跨表单项、不隔着别的控件，支持 `::before` 伪元素标签；可疑标签记 `labelUncertain`。详情页上的入口按钮（`isEntryText`：立即申请 / 申请职位 / 我要投递 / Apply…）在页面没有任何字段时可以点进去。
- **第二重（兜底，宁空不错）**：原生 setter 只给普通可编辑文本框（只读 / combobox / 下拉外壳一律拒绝）；成功以用户可见显示值读回为准；不可搜索的下拉不打字不回车；全选只在焦点就是目标可编辑元素时按；所有策略失败或读回不一致 → 清空回原值，`needs_user` + 原因码（`codes.ts`），清不掉记 `mismatch`；同一字段只写一次（分区填写跳过字段阶段写过 / 计划过的格子）；每个字段 30 秒看门狗；最终提交类按钮任何一层都不点。
- **结果**：`DriveResult.fields`（字段级 `status` / `verified` / `code` / `reason` / `labelUncertain` / `requiredVia`）、`blockers`、`entryClicked`、`libraries`、`telemetry`；`review` 多了 `requiredTrusted` / `requiredNote` / `verified` / `optionalEmpty`，选填留空行标 `empty_optional`（不算要人看），行级 `reasonCode` / `verified`。进度走 `onProgress`（人话），`log` 只是内部调试。
- **运行记录**（`telemetry.ts`，`DriveOptions.telemetry = { dir, runId, keep }`）：`<dir>/<runId>/trace.jsonl`、动作前后小截图（敏感框模糊）、失败 DOM 片段、`summary.json`；值打码；保留最近 keep 次。

## 测试
`FakePage` 是内存 DOM 模型：预置多页字段与按钮（`goto` 跳转、`submit` 标记、`addFields` 添加行、`box` 坐标命中、`domHidden` DOM 看不见、`rejectFill` 吞输入）、验证码 / 登录墙、上传回显与解析自动填充，记录所有动作；`FakePerceiver` 按预置帧回答感知；`pnpm vitest run packages/apply`。
美团式复现页（`test/fixtures/meituan/`，MTD 形态：上传后解析弹窗、只认数据模型的不可搜索下拉、年月面板、吸顶栏、必填星号、添加教育经历、「立即申请」入口与「投递」终点）：`test/meituan-repro.e2e.test.ts` 用无头 Chrome 跑 dist（先 `npm run build`）。
真实 Chrome 冒烟（不依赖 Tauri）：`cd ../../shell && node --import tsx/esm scripts/career-browser-smoke.mjs`（普通表单 / closed shadow DOM 视觉兜底 / 添加行表格）。

## 未实测
- `scripts.ts` 里的 DOM 脚本与 `fromPlaywright` 只能在真实浏览器里验证，单测走的是 FakePage。
- `adapters/`（北森 / Moka / 飞书 / 牛客 / Boss）的按钮文案、登录与风控指示词、字段别名均按公开页面结构尽力编写，**未在真实登录态下验证**。
- 自定义下拉（antd / element）的"点击 + 输入 + 回车"填法未在真实站点验证。
