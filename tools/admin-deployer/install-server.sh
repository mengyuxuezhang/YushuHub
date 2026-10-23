#!/usr/bin/env bash
set -euo pipefail

DEPLOYER_VERSION="1.2.2"
DEPLOYER_ZIP_URL="https://updates.okpa.cn/agent/ai-admin/deployer/Agent-AI-Admin-Deployer-Server-Linux-v1.2.2.zip"
DEPLOYER_ZIP_SHA256="8457caef111d148cc2b1cad687532e4e288778b9c1966218473aa83131c47380"
INSTALL_ROOT="${AGENT_ADMIN_DEPLOYER_HOME:-/www/server/agent-ai-admin-deployer}"
RELEASE_DIR="${INSTALL_ROOT}/releases/${DEPLOYER_VERSION}"
MARKER_FILE="${RELEASE_DIR}/.package-sha256"

fail() {
  echo "安装失败：$*" >&2
  exit 1
}

[ "$(uname -s)" = "Linux" ] || fail "仅支持 Linux 服务器"
command -v curl >/dev/null 2>&1 || fail "未找到 curl"
command -v sha256sum >/dev/null 2>&1 || fail "未找到 sha256sum"
command -v unzip >/dev/null 2>&1 || fail "未找到 unzip"
command -v node >/dev/null 2>&1 || fail "未找到 Node.js，请先在宝塔软件商店安装 Node.js 20 或更高版本"

if [ -f "$MARKER_FILE" ] && [ "$(tr -d '[:space:]' < "$MARKER_FILE")" = "$DEPLOYER_ZIP_SHA256" ]; then
  echo "已安装发版工具 v${DEPLOYER_VERSION}，直接启动。"
  exec bash "${RELEASE_DIR}/start-server.sh"
fi
if [ -e "$RELEASE_DIR" ]; then
  fail "${RELEASE_DIR} 已存在但校验标记不匹配，请改用其他 AGENT_ADMIN_DEPLOYER_HOME 或人工检查该目录"
fi
if [ -e "${INSTALL_ROOT}/current" ] && [ ! -L "${INSTALL_ROOT}/current" ]; then
  fail "${INSTALL_ROOT}/current 已存在且不是符号链接，请人工检查该目录"
fi

TEMP_DIR="$(mktemp -d /tmp/agent-ai-admin-deployer-install.XXXXXX)"
cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

ZIP_FILE="${TEMP_DIR}/deployer.zip"
EXTRACT_DIR="${TEMP_DIR}/extract"
mkdir -p "$EXTRACT_DIR" "${INSTALL_ROOT}/releases"

echo "正在下载 Agent AI Admin 发版工具 v${DEPLOYER_VERSION}..."
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$DEPLOYER_ZIP_URL" --output "$ZIP_FILE"
echo "${DEPLOYER_ZIP_SHA256}  ${ZIP_FILE}" | sha256sum --check --status || fail "下载文件 SHA-256 校验失败"
unzip -oq "$ZIP_FILE" -d "$EXTRACT_DIR"

[ -f "${EXTRACT_DIR}/package.json" ] || fail "安装包缺少 package.json"
[ -f "${EXTRACT_DIR}/start-server.sh" ] || fail "安装包缺少启动脚本"
PACKAGE_VERSION="$(node -p "require('${EXTRACT_DIR}/package.json').version" 2>/dev/null || true)"
[ "$PACKAGE_VERSION" = "$DEPLOYER_VERSION" ] || fail "安装包版本不匹配"

chmod 755 "${EXTRACT_DIR}/start-server.sh"
printf '%s\n' "$DEPLOYER_ZIP_SHA256" > "${EXTRACT_DIR}/.package-sha256"
mv "$EXTRACT_DIR" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "${INSTALL_ROOT}/current"
trap - EXIT INT TERM
rm -rf -- "$TEMP_DIR"

echo "下载、校验和安装完成，正在启动界面。"
exec bash "${RELEASE_DIR}/start-server.sh"
