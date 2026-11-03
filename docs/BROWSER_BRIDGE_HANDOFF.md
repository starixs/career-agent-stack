# Chrome 单通道续作交接

> **后续更新（2026-11-03）**：该工作树已合并。用户否定了手动安装扩展的产品流程；现在由 Rust 自动准备浏览器、Global 预置扩展并启动持久 profile，执行仍保持单一扩展通道。Mac 自动启动、真实扩展本地 OTP 小样及重启保留登录标记已验证；真实站点/手机/邮箱仍待验收。当前规范见 `app/shell/specs/tech_docs/managed_browser.md`。下文保留为本次合并前的历史记录，不再作为安装指南。

工作树：`.claude/worktrees/browser-stealth-driver`，基于 `314c6bcd`，本轮尚未合并/发布。

## 已落地

- 产品聊天、批量、提交、现场共用 `ExtensionBrowserHost`；保留 Rust capability 与接管检查，不再绕过宿主直接取全局 Context。
- 现场沿原 NDJSON frame 协议输出，既有 Renderer 无需第二套帧通道。首帧、静止截图、逐帧 ACK、换页、断连重连、取消清理均走桥。
- debugger 按标签共享租约；输入/多个预览互不拆会话，重复帧 ACK 去重。扩展失去 Sidecar 后清理全部 attachment。
- 接管输入支持真实视口换算、拖拽、滚轮、双击、组合键；文件选择经现有 `/live/file` 在产品内完成。引擎附件上传实际字节；被动 JSON 响应采集走 Network 事件。
- Rust Chromium 下载/维护实现与构建 lock 注入移除；旧命令留下拒绝型升级兼容响应，不删除用户缓存或旧登录数据。
- 移除 Playwright control runtime/原生窗口助手的打包入口与 `keystone-browser` 预设；旧 `/mcp/playwright` 返回 410。普通用户 Playwright preset 不变。
- 包内新增 `career-bridge/` 扩展资源，补上 `@career/captcha` staging。

## 自动验证

在 `app/shell` 执行：

- `npx tsc --noEmit`：通过。
- 本轮变更的 TypeScript 文件 ESLint：通过。
- 桥、现场/浏览器路由、screencast、file-chooser 定向 unit：76 通过。
- `npx vitest run --project integration src/server/browser-host`：7 通过。
- `node --test scripts/browser-runtime-packaging.test.mjs scripts/server-bundle-browser-host.test.mjs`：6 通过，包含隔离 HOME、无 Playwright 运行包的实际发行 Sidecar 启动。
- `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo check --manifest-path src-tauri/Cargo.toml --offline`：通过。只做 Rust 编译检查，未验证完整安装包；默认 cargo check 被当前工作树缺少 `resources/claude-agent-sdk` 阻断。
- 全量 unit：5214 通过，2 个失败，另有 7 个未处理拒绝。已在独立临时 `314c6bcd` 工作树重跑对应测试，确认全部同样存在于本轮修改前：themeArchitecture 的 delivery.css 约束、agent-workspace-identity 的 health 断言，以及 context-registry 假 Page 缺 isClosed 引起的 csp-strip 拒绝。临时工作树已清理，未 stash 用户改动。

## 尚未实机验收

没有替用户安装/启用 Chrome 扩展，没有对真实招聘站执行操作。下一轮在可见测试页中验收：

1. 从安装包 `Resources/career-bridge` 手动加载扩展；产品侧栏显示同一 Chrome 标签页。
2. 接管后点击、拖动、滚动、键盘与附件选择均在产品内完成；交回后 Agent 继续，提交仍需现有批准。
3. 关闭/重开侧栏与扩展，检查画面重连、黄条/文件选择拦截清理；同时开两个预览验证互不拆流。
4. 测试实际网申的跳转、弹出页/iframe、最小化窗口和长时间后台运行。代理只实现引擎使用的 Page 子集，不宣称任意 Playwright API 等价。

真实 Chrome 和完整安装包未验收，不应把自动测试通过写成端到端上线完成。
