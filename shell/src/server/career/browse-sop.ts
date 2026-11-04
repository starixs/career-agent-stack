/**
 * 浏览器操作经验手册（browser_sop 工具按需读给模型）。
 * 来源：GenericAgent 的 memory/tmwebdriver_sop.md（MIT，Copyright (c) 2025 lsdefine），
 * 按产品自己的桥（career-bridge 扩展 + browse 工具）改写；条目保持「遇到什么坑 → 怎么做」。
 */
export const BROWSE_SOP = `浏览器操作手册（点不动 / 点了没反应 / 看不见时按这里查，不要连点）

一、坐标与调试器
- CDP 坐标 = getBoundingClientRect 坐标，稳定后不用修正。
- 首次接上调试器（browser_cdp / 拖动 / 截图）Chrome 会弹「正在受自动化控制」条，页面被推下约 20px：先发一次无害操作（如 Runtime.evaluate 返回 1）再量坐标、再点击。量坐标和点击之间不要跨导航。
- 坐标点不中时先确认元素在视口内：getBoundingClientRect 的 top/bottom 要落在 0 ~ innerHeight 里；不在就先滚动或把元素 scrollIntoView，再重新量。

二、点击
- 可信点击要三事件序列：mouseMoved → mousePressed → mouseReleased（browse 的 click / click_at 已内置）。直接派发 JS click 的 isTrusted=false，部分站点不认。
- 点击没反应先看回执「变化」：出现 / 消失列表空 = 很可能没点中或被遮住；用 Runtime.evaluate 的 elementFromPoint 看坐标下到底是什么。

三、下拉框（自绘 Select / Dropdown）
- 先点开，再量选项坐标点选项：选项是点开后才渲染的 DOM，提前量是空的。选项太多超出视口时，优先用 JS 直接找选项元素 dispatch 可信事件做不到——改用设置 value + 补 input/change 事件，或请用户点。

四、滑块 / 拼图验证
- 第一次拖动前必须先以无害 CDP 调用预热调试器，等黄条布局稳定后重新量坐标；首次 attach 前量的坐标会让拖动起点偏移。
- 优先走 browser_solve_captcha（有视觉模型和拟人轨迹）。
- 需要自己拖时：量缺口位置（图片资源可直接 fetch 下来算），拖动必须拟人（先快后慢、带过冲）；拖完核验成功标志或验证码容器消失，没过不要立刻原样重拖——刷新后会换题。
- 滑块在跨域 iframe 里时，坐标 = iframe 左上角 + 元素在 iframe 里的坐标。

五、跨域 iframe（验证码最常见的位置）
- 主页面 JS 读不到跨域 iframe；用 browser_cdp：Page.getFrameTree 找 frameId → Page.createIsolatedWorld({ frameId }) 拿 contextId → Runtime.evaluate({ expression, contextId }) 在 iframe 里执行。
- Target.attachToTarget 在扩展桥里不可用，不要试。

六、登录协议、发码与成功判定
- 登录/注册页出现「我已阅读并同意」「用户协议」「登录政策」「隐私条款」「服务协议」等必选勾选时，直接勾选，不逐站询问、不额外判断；没有该控件就不制造动作。
- 勾选框可能是隐藏 input、label 或自定义 span，且常在首屏之外：先滚动、scrollIntoView 或临时上移登录容器，再用可信 CDP 点击；点击后读取 checked 或确认「请勾选此项」消失，才算勾上。
- 先准备真实收码通道再点发码；一页一次发送。没有倒计时时先查 toast、协议状态、遮挡和验证结果，不要连点。
- 回填受控组件用原生 value setter + input + change。登录表单消失并进入账号/简历/求职设置页，或出现退出/个人中心，才算登录成功；倒计时和验证码单独通过都不算。
- 全量站点配方与实测阻塞见 app/docs/LOGIN_PLAYBOOK.md。

七、自动填充（浏览器记住的账号）
- 受保护值只在标签页处于前台时释放：先 Page.bringToFront 再点。检测标志：input 带 data-autofilled。

八、页面打不开 / 工具失败
- 导航失败先重试一次（无副作用），仍失败 browser_observe 看当前页再决定。
- 扩展截图超时（15s ack 后无结果）：多半是页面主线程被卡，改用 browser_cdp 的 Page.captureScreenshot 或 Runtime.evaluate 取 DOM 信息。
- 后台标签会被节流，长操作前把标签页切前台（tabs switch / bringToFront）。`;
