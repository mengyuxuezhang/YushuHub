#!/usr/bin/env bash
set -euo pipefail

DEFAULT_ADMIN_HOST="127.0.0.1"
DEFAULT_ADMIN_PORT="7077"
DEFAULT_PM2_NAME="agent-ai-admin"
DEFAULT_BUILD_CENTER_URL="https://center.okpa.cn"
DEFAULT_SOURCE_VERSION_URL="https://updates.okpa.cn/agent/next-source/latest.json"
DEFAULT_ADMIN_UPDATE_MANIFEST_URL="https://updates.okpa.cn/agent/ai-admin/latest.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

fail() {
  echo "[install-local] $*" >&2
  exit 1
}

info() {
  echo "[install-local] $*"
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  has_command "$1" || fail "缺少命令：$1。请先在宝塔/服务器里安装后重试。"
}

major_version() {
  local raw="$1"
  raw="${raw#v}"
  echo "${raw%%.*}"
}

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local value=""
  [ -r /dev/tty ] || fail "当前环境没有可交互终端。请在宝塔终端或 SSH 终端中执行：bash scripts/install-local.sh"
  if [ -n "$default_value" ]; then
    read -r -p "$label [$default_value，直接回车使用默认值]: " value < /dev/tty || true
    echo "${value:-$default_value}"
  else
    read -r -p "$label: " value < /dev/tty || true
    echo "$value"
  fi
}

prompt_secret() {
  local label="$1"
  local value=""
  [ -r /dev/tty ] || fail "当前环境没有可交互终端。请在宝塔终端或 SSH 终端中执行：bash scripts/install-local.sh"
  read -r -p "$label（明文显示，便于核对）: " value < /dev/tty || true
  echo "$value"
}

normalize_url() {
  local value="$1"
  if [ -n "$value" ] && [[ "$value" != http://* ]] && [[ "$value" != https://* ]]; then
    value="http://$value"
  fi
  value="${value%/}"
  echo "$value"
}

instance_defaults() {
  local url="$1"
  AI_INSTANCE_URL="$url" node - <<'NODE'
const crypto = require('crypto');
const raw = process.env.AI_INSTANCE_URL || '';
let host = raw;
try {
  host = new URL(raw).hostname || raw;
} catch {}
const slug = String(host || 'supplier')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 36) || 'supplier';
const hash = crypto.createHash('sha1').update(raw || host || slug).digest();
const port = 7100 + hash.readUInt16BE(0) % 800;
console.log(`agent-ai-admin-${slug} ${port}`);
NODE
}

random_hex() {
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
}

write_env() {
  local env_path="$1"
  cat > "$env_path" <<EOF
AI_ADMIN_HOST=$ADMIN_HOST
AI_ADMIN_PORT=$ADMIN_PORT
AI_ADMIN_USER=$ADMIN_USER
AI_ADMIN_PASSWORD=$ADMIN_PASSWORD

AI_DB_HOST=$DB_HOST
AI_DB_PORT=$DB_PORT
AI_DB_USER=$DB_USER
AI_DB_PASSWORD=$DB_PASSWORD
AI_DB_NAME=$DB_NAME

AI_WORKER_TOKEN=$WORKER_TOKEN

AI_ADMIN_PUBLIC_URL=$ADMIN_PUBLIC_URL
AI_BUILD_CENTER_PUBLIC_URL=$ADMIN_PUBLIC_URL
AI_CENTER_SUPPLIER_MANAGEMENT=0
AI_UPDATE_ROOT=$INSTALL_DIR/updates/ai
AI_UPDATE_BASE_URL=$ADMIN_PUBLIC_URL/updates/ai
AI_PREVIEW_ROOT=$INSTALL_DIR/updates/ai-staging
AI_PREVIEW_BASE_URL=$ADMIN_PUBLIC_URL/updates/ai-staging

AI_BUILD_CENTER_URL=$BUILD_CENTER_URL
AI_BUILD_CENTER_TOKEN=$BUILD_CENTER_TOKEN
AI_BUILD_CENTER_SUPPLIER_ID=$BUILD_CENTER_SUPPLIER_ID

AI_SOURCE_VERSION=
AI_SOURCE_VERSION_URL=$DEFAULT_SOURCE_VERSION_URL

AI_ADMIN_UPDATE_MANIFEST_URL=$DEFAULT_ADMIN_UPDATE_MANIFEST_URL
AI_ADMIN_PM2_NAME=$PM2_NAME
AI_ADMIN_PM2_BIN=pm2
AI_ADMIN_NPM_BIN=npm

AI_BRAND_ASSET_IMAGE_BED_UPLOAD_URL=https://assets.okpa.cn/upload
EOF
  chmod 600 "$env_path"
}

test_database() {
  info "测试数据库连接"
  AI_DB_HOST="$DB_HOST" \
  AI_DB_PORT="$DB_PORT" \
  AI_DB_USER="$DB_USER" \
  AI_DB_PASSWORD="$DB_PASSWORD" \
  AI_DB_NAME="$DB_NAME" \
  node - <<'NODE'
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.AI_DB_HOST || '127.0.0.1',
      port: Number(process.env.AI_DB_PORT || 3306),
      user: process.env.AI_DB_USER || '',
      password: process.env.AI_DB_PASSWORD || '',
      database: process.env.AI_DB_NAME || '',
    });
    await conn.query('SELECT 1');
    await conn.end();
    console.log('[install-local] 数据库连接成功');
  } catch (err) {
    console.error('[install-local] 数据库连接失败：' + (err && err.message ? err.message : String(err)));
    console.error('[install-local] 请检查宝塔数据库名、用户名、密码和访问权限是否与填写内容一致。');
    process.exit(1);
  }
})();
NODE
}

echo "============================================================"
echo " Agent AI 管理后台本地源码包安装脚本"
echo "============================================================"
echo
echo "当前源码目录：$INSTALL_DIR"
echo "请先在宝塔创建网站、数据库，并给域名配置 SSL。"
echo "带默认值的选项可以直接回车跳过；公网地址、数据库名、数据库用户、管理员账号需要手动填写。"
echo

require_command node
require_command npm
require_command pm2

NODE_MAJOR="$(major_version "$(node -v)")"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 版本必须 >= 20，当前为 $(node -v)。请先在宝塔 Node.js 版本管理中切换到 Node 20+。"

ADMIN_PUBLIC_URL="$(normalize_url "$(prompt "请输入后台公网地址，例如 https://ai.example.com" "")")"
[ -n "$ADMIN_PUBLIC_URL" ] || fail "后台公网地址不能为空。"
INSTANCE_DEFAULTS="$(instance_defaults "$ADMIN_PUBLIC_URL")"
DEFAULT_INSTANCE_PM2="${INSTANCE_DEFAULTS% *}"
DEFAULT_INSTANCE_PORT="${INSTANCE_DEFAULTS##* }"

DB_HOST="$(prompt "数据库地址" "127.0.0.1")"
DB_PORT="$(prompt "数据库端口" "3306")"
DB_NAME="$(prompt "数据库名" "")"
[ -n "$DB_NAME" ] || fail "数据库名不能为空。"
DB_USER="$(prompt "数据库用户" "")"
[ -n "$DB_USER" ] || fail "数据库用户不能为空。"
DB_PASSWORD="$(prompt_secret "数据库密码")"

ADMIN_HOST="$(prompt "Node 监听地址" "$DEFAULT_ADMIN_HOST")"
ADMIN_PORT="$(prompt "Node 端口" "$DEFAULT_INSTANCE_PORT")"
ADMIN_USER="$(prompt "管理员账号" "")"
[ -n "$ADMIN_USER" ] || fail "管理员账号不能为空。"
ADMIN_PASSWORD="$(prompt_secret "管理员密码，至少 8 位")"
[ "${#ADMIN_PASSWORD}" -ge 8 ] || fail "管理员密码至少 8 位。"

echo
echo "官方构建中心配置可以先留空，安装后也可在后台 平台设置 -> 官方构建中心 中填写。"
BUILD_CENTER_URL="$(prompt "官方构建中心 URL" "$DEFAULT_BUILD_CENTER_URL")"
BUILD_CENTER_SUPPLIER_ID="$(prompt "Supplier ID，可留空" "")"
BUILD_CENTER_TOKEN="$(prompt_secret "Token，可留空")"
PM2_NAME="$(prompt "PM2 服务名" "$DEFAULT_INSTANCE_PM2")"

mkdir -p "$INSTALL_DIR/updates/ai" "$INSTALL_DIR/updates/ai-staging"
WORKER_TOKEN="$(random_hex)"
write_env "$INSTALL_DIR/.env"

info "安装 Node 依赖"
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund
test_database

info "启动 PM2 服务：$PM2_NAME"
pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
pm2 start cloud/ai-admin/server.mjs --name "$PM2_NAME" --interpreter node --update-env
pm2 save >/dev/null 2>&1 || true

echo
echo "============================================================"
echo "安装完成"
echo "============================================================"
echo "后台服务已启动：$PM2_NAME"
echo "Node 地址：http://$ADMIN_HOST:$ADMIN_PORT"
echo
echo "请在宝塔网站 -> 反向代理中添加："
echo "代理名称：$PM2_NAME"
echo "目标 URL：http://$ADMIN_HOST:$ADMIN_PORT"
echo "发送域名：你的域名"
echo
echo "SSL 请继续在宝塔网站设置里申请/续期。"
echo
echo "后台访问地址：$ADMIN_PUBLIC_URL"
echo
