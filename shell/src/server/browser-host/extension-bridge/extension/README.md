# career-bridge 扩展

把**用户自己的真实 Chrome** 接到产品 sidecar 上执行自动化。架构移植自
[lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent) 的
`assets/tmwd_cdp_bridge`（MIT）：扩展 background 主动连出到
`ws://127.0.0.1:18775`，页面零自动化痕迹——没有 CDP-at-launch、没有
`--enable-automation`，`navigator.webdriver` 在 `document_start` 就被删掉，
登录态 / Cookie / GPU / WebGL 指纹全部是用户真实浏览器的。

## 安装（未打包加载）

1. 打开 Chrome → `chrome://extensions`
2. 右上角开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择含 `manifest.json` 的目录：开发时是本目录，安装版是应用 Resources 下的 `career-bridge/`
4. 右下角角标显示 `career-bridge: 已连接` 即桥通

> 在日常 Chrome 中手动加载。产品不再启动或维护第二个托管 Chromium，
> 也不接管 Chrome 的更新、Cookie 存储和窗口尺寸。

## 能力

| 命令 | 说明 |
|---|---|
| `{cmd:'tabs'}` | 列出可脚本化的标签页 |
| `{cmd:'cookies', url}` | 读 Cookie（含 partitioned） |
| `{cmd:'cdp', tabId, method, params}` | 单条 CDP 命令（per-command attach，用完即散） |
| `{cmd:'cdp_attach'/'cdp_detach', tabId}` | 持久 CDP 会话（screencast 等要持续事件的场景；attach 期间 Chrome 顶部有"正在调试此浏览器"黄条，用完必须 detach） |
| `{cmd:'batch', commands:[...]}` | 批量链式命令，`$N.path` 引用第 N 个结果 |
| `{id, tabId, code}` | 在标签页主世界执行 JS（CSP 站自动 CDP 兜底） |

上行事件（扩展 → 服务端）：`tabs_update`（标签增删改）、`cdp_event`
（持久会话的 CDP 事件，如 `Page.screencastFrame` 帧流）、`cdp_detached`
（用户点了黄条"取消" / 标签页关闭）。生产现场经 `BridgeCdp` 共享 debugger
租约，`ScreencastHub` 逐帧 ACK 并补静止截图，沿 `/api/career/live/stream?frames=1`
输出标准 NDJSON frame。多个预览/输入全部释放后才 detach；不再经普通 LiveHub
广播 base64 原始帧。

内容脚本：`disable-dialogs.js` 删 `navigator.webdriver` + 中和 alert/confirm/prompt；
`badge.js` 右下角连接角标。
