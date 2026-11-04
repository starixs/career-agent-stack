# 浏览器宿主：产品自动准备，扩展单通道

用户不需要安装扩展、开启开发者模式、选择目录或配置端口。原「只接用户日常 Chrome」方案缺少产品级首次接入，已按 2026-11-03 用户确认调整。网站首次登录也继续尽量自动完成，不能把免装扩展换成手动登录。

## Owner 与启动

- Rust `browser_resource` 是浏览器二进制的唯一 owner：应用启动自动检查，首次自动下载锁定的官方 headed Chrome for Testing / Chromium。复用 `managed-browser-runtime.json` 的平台、版本、SHA-256、大小与条目数；不依赖用户安装 Node、Playwright 或 Chrome。
- 官方 HTTPS 下载禁止重定向，流量/时限有界，校验后安全解包。沿用文件锁、磁盘空间检查和同盘 staging/替换；校验失败不重试，不将半包发布为就绪。应用更新仍由同一 lock 决定版本，不在失败时偷偷切换 latest。
- Global Sidecar 等待 Rust 资源就绪，预置扩展，再启动一个产品专用浏览器进程。`~/.keystone/browser-profile/product` 跨任务和重启保留；不修改日常 Chrome 的 Preferences、企业 policy，不读取或复制它的 Cookie。
- **唯一执行通道仍是 ExtensionBridge → ExtensionBrowserHost。** 不恢复 Playwright browser launch / CDP-at-launch 第二驱动，不携带 Playwright control runtime；CDP 仅由扩展在需要输入、截图等操作时借用 debugger。
- 应用安装级连接密钥只存在私有本机文件，扩展先鉴权再发布标签；不能靠任意 localhost WebSocket 的 ping 抢占连接。密钥不能每次 Sidecar 重启轮换：MV3 可能缓存已加载脚本。扩展按源码与连接配置的内容摘要预置到不可变目录，更新时避免复用旧 worker。
- Rust 仍校验 Session capability。Session Sidecar 不抢占桥端口；聊天、后台批量、已批准提交、登录之旅和现场都借用 Global 的同一 Context。产品启动预热浏览器，任务遇到准备中时等待；查看现场不另起进程。
- 正常关闭只终止本产品创建的子进程，不扫描杀死用户 Chrome。Session 退役不删除全局浏览器或登录态。网络/磁盘/启动失败有明确状态，不再提示手装扩展。关闭浏览器后，下一次执行任务可自动启动；连接短暂中断由扩展探活恢复。

## 页面、画面与输入

- 新标签的 `pendingUrl` / `about:blank` 必须保留；串行发布标签快照。创建响应之后到达的旧快照不能误关尚未被快照观察到的新 Page。
- 导航用 `chrome.tabs.update` 并等待完成，不依赖在空白页执行脚本。标签原生导航不与正在截图的 debugger 租约冲突。
- 点击前先激活工作标签并完成 debugger attach，再读坐标。实机发现后台页的可信鼠标事件会严重延迟，attach 也可能改变布局；不能仅靠假 Page 测试声称可用。
- `/api/career/live/stream?frames=1` 沿用 snapshot、frame-status、frame、heartbeat；未就绪时显示自动准备/连接/失败状态。`ScreencastHub` 逐帧 ACK 并补静止截图，不把 base64 广播到普通事件订阅者。
- `BridgeCdp` 按标签共享 debugger 租约；预览、输入、被动采集各自借用，最后一份退出才 detach。取消、关页和断连清理监听、计时器及租约；重连后现场重新挂接。
- 同一浏览器只有一个接管锁。用户接管后禁止所有 Agent 新借用；准备完成时也重新核对控制权和取消信号。文件选择复用 `FileChooserBroker`，输入与帧使用真实 CSS 坐标。
- 登录之旅 pin 优先于引擎工作页；读取页面不能抢夺工作页焦点。当前不新增隐藏/最小化/窗口尺寸控制；Chrome 调试黄条是平台行为，不能承诺不存在。

## 登录与验证

自动浏览器就绪后继续复用 `@career/apply` 的私有验证钩子：按已授权的手机号/邮箱请求、等待、回填新码，确认通过后继续填写或已批准提交。图形验证先自动尝试，失败、扫码、人脸等仍保留接管。最终提交审批不因自动登录而放宽。

**尚未完成的产品覆盖**：真实站点模板、手机/邮箱实机收码和完整首次登录成功率尚未验收；`verification.json` 只是开发/定向验收配置，不是让最终用户手工填写选择器的产品方案。详见 `app/docs/APPLY_VERIFICATION.md`。

## 验证

- 确定性测试覆盖资源锁与路径限制、安装状态、接入鉴权、准备只执行一次、取消不晚启动、保留 profile、断线重连、标签生命周期与可信点击顺序；原能力令牌/接管/帧/文件选择回归仍保留。
- `node --import tsx/esm scripts/career-product-browser-smoke.mjs` 使用已由桌面校验的浏览器、隔离 profile 和真实扩展，跑本地短信/邮箱登录页；收码是固定替身，不发真实短信/邮件、不投递。
- 本轮 Mac 实测：首次自动下载/校验/启动/扩展握手通过；两条本地登录流程通过；同一 profile 重启自动连接并保留本地登录标记。重启曾暴露 MV3 配置缓存问题，已用安装级密钥及内容寻址扩展目录修正。
- 这些结果不代表招聘站、人脸/扫码、真实邮件/蓝牙或 Windows/Linux 安装包已经验收。普通 Playwright preset、Tauri BrowserPanel 仍不是这条产品执行通道。
