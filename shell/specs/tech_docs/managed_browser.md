# 浏览器宿主：Chrome 扩展单通道

产品浏览器现由 `ExtensionBrowserHost` 接入用户日常 Chrome。旧文件名保留供架构文档链接使用；普通 `playwright` preset 和 Tauri `BrowserPanel` 不属于这个宿主。

## Owner 与入口

- Chrome 进程、窗口、标签页、Cookie 和更新归用户/Chrome 所有。产品不启动第二个 Chromium，不复制 Cookie，不因 Session 退役或 Sidecar 退出关闭用户标签页，也不隐藏、最小化或调整用户窗口。
- Global Sidecar 启动 `ExtensionBridge`，扩展主动连接。`BridgePageProxySet` 立即读取当前标签快照，然后订阅增删改；断连时旧代理失效，重连时建立新代理。
- Rust `BrowserRuntimeAuthority` 继续签发和校验 Session capability；移除浏览器安装器不等于移除鉴权。聊天经 `withContext`，Global 批量/提交/登录之旅/现场经 `withProductSession`，最终使用同一个桥 Context。
- 一台物理浏览器只有一个接管锁。用户接管期间禁止新 Agent 借用（含其它 Session）；现场只读借用不改控制权。原有提交确认与数据库动作状态机不变。
- 引擎通过 `focusPage` 指定工作页，`pages()` 将它放首位。登录之旅的 pin 优先。读取标题、检查页面不能反过来抢走显示焦点。

## 画面与输入

`/api/career/live/stream?frames=1` 沿用已有 NDJSON 协议：snapshot、frame-status、frame、heartbeat。`ScreencastHub` 经 Page 适配器调用桥 CDP；帧带 width/height/ts/source，兼容现有 Renderer，不另造 SSE 帧通道。普通 LiveHub 订阅者不接收 base64 原始 CDP 帧。

- `BridgeCdp` 按标签管理 debugger 租约。输入和多个预览各自借用；最后一份租约退出才 detach，关一个预览不打断另一个预览或输入。
- 帧逐个 ACK；静止页补截图。流取消、启动失败、扩展断连时清理监听、计时器和租约；重连后等待流自动重新接入。
- 输入仍必须先接管。帧坐标按真实 CSS 视口换算；拖拽保留最后坐标和按键状态，支持滚轮、双击及组合键。
- 输入租约拦截 `Page.fileChooserOpened`，通过已有 `FileChooserBroker` 和 `/live/file` 在产品内选择附件；交回时关闭拦截，完成/取消/过期释放远程对象。引擎路径上传真实文件字节，不发送空占位文件。
- 被动采集经 Network 事件等待响应完成后读取 JSON body，不拦截或重放请求；移除最后一个监听者时释放 observer 租约。
- `/live/viewport` 返回 unsupported，不修改真实窗口尺寸。`/live/window` 的显示动作只切换到工作标签，隐藏动作不隐藏用户 Chrome。
- Chrome 调试黄条是平台行为，无法保证隐藏；输入执行或预览持有 debugger 时可能显示。不能把“当前有画面”说成“无自动化痕迹”。

## 旧链路退役

- 不再支持 `CAREER_BROWSER_MANAGED` 后备开关；桥未连接返回明确错误。
- 移除 `keystone-browser` 预设注册，保留该 ID 的防冒名保护；旧 `/mcp/playwright` 返回 410。普通用户自配 Playwright preset 不变。
- Rust 浏览器资源模块仅保留升级兼容的 status/install/maintain 拒绝响应。下载、解压、维护与 executable resolution 已移除；build.rs 不再读取浏览器资源 lock。
- 安装包不携带 Playwright control runtime 或原生窗口助手；改为携带 `career-bridge/` 扩展目录。`@career/captcha` 加入领域包 staging，避免只在开发 checkout 能启动。
- 旧托管实现、资源 lock 和测试源码仍可用于历史回归，但不再接到产品启动/构建入口。用户旧 profile、登录存储和下载缓存未删除。

## 验证与边界

确定性测试覆盖真实宿主/代理/现场路由的组合：已有标签首灌、capability、跨调用方接管、帧格式/ACK、断连重连、输入坐标、双租约、取消清理、产品内选文件、被动响应采集及本地附件字节。发行 Sidecar 在隔离 HOME 下、没有任何 Playwright 包时启动并校验新/退役接口。

这些测试使用替身扩展，不等于真实 Chrome 或招聘网站验收。仍需实机核对画面/拖拽/选文件/导航，以及各站点 iframe、原生对话框和页面事件；不能据类型检查或替身测试宣称所有 browse/apply 能力已完全等价。“到浏览器看”保留为用户主动选择的同一页面入口，不是另一条浏览器执行通道。
