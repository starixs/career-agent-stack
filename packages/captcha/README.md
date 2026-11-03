# @career/captcha

验证码自动求解能力库：检测（厂商 / 种类 / 容器矩形）、CDP 人类化可信输入（三事件序列、贝塞尔轨迹、过冲回拉拖动）、四类求解器（滑块 / 图点选 / 图形字符 / 浏览器环境检查）、站点预算策略（当天次数 + 连败冷却）。

架构参考 lsdefine/GenericAgent 的 TMWebDriver 实测结论（MIT）。

## 用法

```ts
import { detectCaptcha, solveCaptcha, CaptchaPolicy, siteKeyOf } from '@career/captcha'

const target = await detectCaptcha(page)            // page: CaptchaPage（shell 侧由 playwright Page 适配）
const policy = new CaptchaPolicy({ siteDailyBudget: 6 })
if (policy.canAttempt(siteKeyOf(page.url())).ok) {
  const r = await solveCaptcha({ page, llm }, target) // llm: @career/core 的 LLM（需视觉）
  policy.record(siteKeyOf(page.url()), target.kind, r.outcome === 'passed' ? 'passed' : 'failed')
}
```

## 边界

- 短信码永远 `unsupported`（拿不到用户手机）；最终提交前的验证码由调用方策略拒绝（契约 §8）。
- 没有 CDP 会话的页面返回 `needs_cdp`，不盲试 DOM 事件。
- shell 侧的 `career/captcha-solver.ts`（网格化坐标方案，视觉模型报格子号不报像素）仍是托管浏览器路径的主力求解器；本包提供它的能力底座（人类输入 / 预算 / browser_check）。
- 视觉估距与点选坐标的**准确率取决于视觉模型**；求解器只承诺"机制正确 + 失败不硬碰"，不承诺全过。
