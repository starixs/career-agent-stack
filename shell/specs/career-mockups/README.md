# 求职助理静态样稿

配合 [`../CAREER_DESIGN.md`](../CAREER_DESIGN.md) 使用。这里只有 HTML 样稿和出图，不是产品代码。

| 文件 | 内容 |
|---|---|
| `career-shell.html` | 各一级页面样稿，`?page=` 取 `work` / `chat` / `chat-long` / `career` / `market` / `assets` / `settings` / `browser-card` / `browser-open` / `browser-handoff`；`&body=kai` 可把长正文切回文楷做对比 |
| `shell-*.png` | 上面各页的出图（1440×900，2 倍图，浅色） |
| `tuning.html`、`tuning/var-1…7.png` | 细节变量对比板：每张只变一个变量，A/B/C 三档 |
| `compare-*.png` | 正文字体、英文字体的对比图 |
| `history/` | 早期配色与风格探索，已被当前方向取代 |
| `reference/` | 用户提供的导航参考稿 |
| `tools/` | 出图脚本 |

## 重新出图

需要本机的 Google Chrome，并借用 `app/shell` 里已安装的 Playwright：

```bash
export PW=$PWD/../../node_modules/playwright   # 在本目录下执行
node tools/shoot.cjs "$PWD/career-shell.html" "$PWD/shell-chat.png" "page=chat"
node tools/shoot-tuning.cjs "$PWD/tuning.html" "$PWD/tuning"
```

样稿里的霞鹜文楷和 Source Sans 3 从 CDN 临时加载，出图需要联网；正式产品要把字体打包进应用。
