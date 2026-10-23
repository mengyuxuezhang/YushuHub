#!/usr/bin/env bash
set -euo pipefail

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$TOOL_DIR"

if [ "$(uname -s)" != "Linux" ]; then
  echo "此启动脚本仅支持 Linux 服务器" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先在宝塔软件商店安装 Node.js 20 或更高版本" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 版本过低，当前为 $(node -v)，需要 20 或更高版本" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm，请先完成 Node.js 环境安装" >&2
  exit 1
fi

if [ ! -d node_modules/mysql2 ] || [ ! -d node_modules/ssh2 ]; then
  echo "首次运行：正在安装发版工具依赖..."
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "警告：当前不是 root 用户，安装目录、PM2 或宝塔 Nginx 操作可能因权限不足失败。" >&2
fi

export AGENT_ADMIN_DEPLOYER_LOCAL=1
export AGENT_ADMIN_DEPLOYER_BIND="${AGENT_ADMIN_DEPLOYER_BIND:-0.0.0.0}"
export AGENT_ADMIN_DEPLOYER_LIFETIME="${AGENT_ADMIN_DEPLOYER_LIFETIME:-7200}"

echo "正在启动服务器本地发版工具。请只使用下方带访问令牌的完整地址，使用结束后按 Ctrl+C 关闭。"
exec node src/gui.mjs
