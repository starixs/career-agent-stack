#!/usr/bin/env bash
# 求职助理：一键启动桌面开发模式（Tauri）。
# 用法：CAREER_LLM_API_KEY=xxx ./start_desktop.sh      或先 export 再运行
# 内置模型走 DeepSeek 的 Anthropic 兼容原生协议（${CAREER_LLM_BASE_URL}/v1/messages，Bearer 鉴权），不经 OpenAI 翻译桥。
# 说明：不走 npm run tauri:dev 的两个资源准备脚本（CLIProxy / 语音模型），产品不需要它们。
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${CAREER_LLM_API_KEY:-}" ]; then
  echo "✗ 缺少 CAREER_LLM_API_KEY（DeepSeek API key）。例：CAREER_LLM_API_KEY=sk-... ./start_desktop.sh"; exit 1
fi
export CAREER_LLM_BASE_URL="${CAREER_LLM_BASE_URL:-https://api.deepseek.com/anthropic}"
export CAREER_LLM_MODEL="${CAREER_LLM_MODEL:-deepseek-flash}"
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
# 清理残留进程：浏览器模式的侧车/Vite，以及上一次桌面 App 被强杀后遗留的会话侧车
# （侧车是 App 的子进程，App 被 kill -9 时不会跟着退出；旧侧车会继续用旧代码服务，改动看起来"不生效"）。
pkill -f "node.*src/server/index.ts" 2>/dev/null || true
pkill -f "node.*server-dist.js" 2>/dev/null || true
pkill -f "node_modules/.bin/vite" 2>/dev/null || true
pkill -x keystone 2>/dev/null || true
sleep 1
# 资源目录自检（首次需要的生成步骤）
[ -x src-tauri/resources/nodejs/bin/node ] || bash scripts/download_nodejs.sh
[ -d src-tauri/resources/tsx-runtime ] || node scripts/setup-tsx-runtime.mjs darwin arm64
[ -d src-tauri/resources/sharp-runtime ] || node scripts/prepare-sharp-runtime.mjs darwin arm64
[ -f src-tauri/resources/plugin-bridge-dist.mjs ] || npm run build:bridge
[ -f src-tauri/resources/claude-agent-sdk/claude ] || { mkdir -p src-tauri/resources/claude-agent-sdk && cp node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude src-tauri/resources/claude-agent-sdk/claude && chmod +x src-tauri/resources/claude-agent-sdk/claude; }
echo "▶ 启动求职助理（Tauri dev）… 日志: ${TAURI_DEV_LOG:-/tmp/career-tauri-dev.log}"
exec npx tauri dev
