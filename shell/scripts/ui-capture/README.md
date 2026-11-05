# ui-capture：每页截图

给设计诊断用：种一份秋招中段学生（虚构「林同学」）的演示数据，在浏览器模式下截下求职产品左栏和功能市场能打开的每一页，外加 3 页深色。

## 重跑（在 app/shell 下）

```sh
node scripts/ui-capture/run.mjs --data /tmp/career-ui-home --out /tmp/career-ui-shots
```

做的事：清空 `--data` → `seed.mjs` 种数据 → 起 Global 侧车（:3000，vite 代理写死的目标）和 vite（:5175）→ `capture.mjs` 截图并写 `index.md` → 停掉两个服务。端口被占用时直接退出。`--only today,apply` 只截部分页面（页 id 见 capture.mjs 的 PAGES）。

数据只写进 `--data`（`CAREER_DATA_DIR` / `KEYSTONE_CONFIG_DIR` / `KEYSTONE_REFS_DIR`），不写仓库、不碰 `~/.keystone/career`。

## 文件

- `seed.mjs`：走侧车自己的路由（进程内 `handleCareerRoute`）和 `@career/core` Repos 写数据：基本资料、3 段经历、1 主简历 + 2 定制、首次打开自动导入的校招岗位（约 120）+ 28 家常见公司、28 份投递（已投 / 不合适 / 面试 / Offer / 等过目 3 / 要登录 2 / 缺信息 1 / 没填成 2）、面试、2 场笔试测评、Offer、网申截止、6 条通知。
- `capture.mjs`：导航走产品的 `career:navigate` 事件（与左栏点击同一入口）；每页记页面异常、console.error、/api 非 2xx 和「界面渲染出错」；主区超过一屏时补一张 `*-2.png`。服务已在跑时可单独运行：`node scripts/ui-capture/capture.mjs --out <dir>`。

## 已知限制

对话页需要 Tauri 起会话侧车，浏览器模式下中间停在「小芽在准备」，只有右栏真实；网申进展页的浏览器面板显示「浏览器未打开」。
