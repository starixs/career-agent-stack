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
3. 「加载已解压的扩展程序」→ 选本目录（含 `manifest.json` 的这层）
4. 右下角角标显示 `career-bridge: 已连接` 即桥通

> 注意：Chrome 136+ 品牌版已禁用 `--load-extension` 启动参数，所以托管的
> Chrome 只能手动装；托管 Chromium（`CAREER_BROWSER_CHANNEL=chromium`）仍可
> 用启动参数自动加载（见 `stage-extension.ts`）。

## 能力

| 命令 | 说明 |
|---|---|
| `{cmd:'tabs'}` | 列出可脚本化的标签页 |
| `{cmd:'cookies', url}` | 读 Cookie（含 partitioned） |
| `{cmd:'cdp', tabId, method, params}` | 单条 CDP 命令（per-tab attach） |
| `{cmd:'batch', commands:[...]}` | 批量链式命令，`$N.path` 引用第 N 个结果 |
| `{id, tabId, code}` | 在标签页主世界执行 JS（CSP 站自动 CDP 兜底） |

内容脚本：`disable-dialogs.js` 删 `navigator.webdriver` + 中和 alert/confirm/prompt；
`badge.js` 右下角连接角标。
