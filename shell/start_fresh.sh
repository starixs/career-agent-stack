#!/usr/bin/env bash
# 单独起一个「全新用户」实例：数据全在独立的空 HOME 里，不碰原来的 ~/.keystone 和正在跑的实例。
# - HOME 指到 $FRESH_HOME（默认 ~/.career-fresh），~/.keystone、求职数据库、邮箱授权码、托管 Chrome 资料都会落在那里
# - 应用标识换成 com.keystone.app.fresh：单实例锁和原来那个分开，两个实例可以同时开
# - 前端用 5174 端口；不杀任何进程（不要用 start_desktop.sh，它会把正在跑的实例全部杀掉）
# 重来一次：退出这个实例后删掉 $FRESH_HOME 再运行本脚本。
set -euo pipefail
cd "$(dirname "$0")"

REAL_HOME="$HOME"
FRESH_HOME="${FRESH_HOME:-$REAL_HOME/.career-fresh}"
mkdir -p "$FRESH_HOME"

# 换了 HOME 以后，Rust / npm 仍用原来的工具链和缓存（这些不是用户数据）
export CARGO_HOME="${CARGO_HOME:-$REAL_HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$REAL_HOME/.rustup}"
export npm_config_cache="${npm_config_cache:-$REAL_HOME/.npm}"
export PATH="$CARGO_HOME/bin:$PATH"

export CAREER_LLM_BASE_URL="${CAREER_LLM_BASE_URL:-https://api.deepseek.com/anthropic}"
export CAREER_LLM_MODEL="${CAREER_LLM_MODEL:-deepseek-flash}"
export SHARP_IGNORE_GLOBAL_LIBVIPS=1

# macOS：target 里的 node 若被原地覆盖或克隆，内核会缓存失效签名，侧车一启动就被 SIGKILL（同 start_desktop.sh）
if [ -f src-tauri/resources/nodejs/bin/node ] && [ -d src-tauri/target/debug/nodejs/bin ]; then
  cp src-tauri/resources/nodejs/bin/node src-tauri/target/debug/nodejs/bin/node.fresh && mv -f src-tauri/target/debug/nodejs/bin/node.fresh src-tauri/target/debug/nodejs/bin/node
fi

echo "全新实例：数据目录 $FRESH_HOME/.keystone（原来的 $REAL_HOME/.keystone 不受影响）"
HOME="$FRESH_HOME" exec npx tauri dev --config '{"identifier":"com.keystone.app.fresh","build":{"devUrl":"http://localhost:5174","beforeDevCommand":"npm run dev:web -- --port 5174 --strictPort"}}'
