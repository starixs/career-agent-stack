# @career/captcha

验证码自动求解能力库：检测（厂商 / 种类 / 容器矩形）、CDP 人类化可信输入（首次预热、三事件序列、贝塞尔轨迹、过冲回拉、随机打字与偶尔删改）、五类求解器（滑块 / 旋转 / 图点选 / 图形字符 / 浏览器环境检查）、站点预算策略（当天次数 + 连败冷却 + 最短间隔）。

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

- 短信/邮箱 OTP 不在本包读取，交由宿主已授权的收码通道；没有通道时留给人工。
- 没有 CDP 会话的页面返回 `needs_cdp`，不盲试 DOM 事件。
- 滑块使用高置信度像素边缘优先、视觉估距兜底的策略；旋转复用同一张截图完成环带相关性或视觉估角，拖动后都必须重新检测通过状态。
- 点选使用网格化视觉识别，不额外下载 PaddleOCR / Tesseract 模型。验证结果采用有界轮询，一通过就继续，不固定等满；所有图像分析只处理当前验证码区域，不保存页面或验证码图片。
- 视觉估距、估角与点选的准确率取决于图像和模型；求解器只承诺「机制正确 + 失败不硬碰」，不承诺全站通过。
