#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" != "--apply" ]; then
  echo '只读计划：检查Linux/Python3.8+/Docker/Compose，安装受控CLI；不登记实例、不停止服务。实际安装使用 --apply。'
  exit 0
fi
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo '首批只支持Linux amd64' >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo '需要root安装控制器' >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info >= (3,8)'
docker info >/dev/null
docker compose version >/dev/null
TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVISION="$(cd "$TOOL_DIR" && sha256sum controller.py engine.py state.py scan.py authorization-probe.mjs runtime-contract.mjs | sha256sum | cut -d ' ' -f1)"
RELEASE="/opt/yushuhub-upgrade-controller/releases/$REVISION"
if [ -e /opt/yushuhub-upgrade-controller/current ] && [ ! -L /opt/yushuhub-upgrade-controller/current ]; then
  echo 'current不是链接，停止安装以保留现有目录' >&2
  exit 1
fi
if [ ! -d "$RELEASE" ]; then
  install -d -m 700 /opt/yushuhub-upgrade-controller/releases
  STAGE="$(mktemp -d /opt/yushuhub-upgrade-controller/releases/.install.XXXXXX)"
  trap 'rm -rf -- "$STAGE"' EXIT
  for name in controller.py engine.py state.py scan.py authorization-probe.mjs runtime-contract.mjs; do install -m 600 "$TOOL_DIR/$name" "$STAGE/$name"; done
  mv "$STAGE" "$RELEASE"
  trap - EXIT
fi
for name in controller.py engine.py state.py scan.py authorization-probe.mjs runtime-contract.mjs; do
  [ "$(sha256sum "$TOOL_DIR/$name" | cut -d ' ' -f1)" = "$(sha256sum "$RELEASE/$name" | cut -d ' ' -f1)" ] || { echo '控制器发布目录校验失败' >&2; exit 1; }
done
install -d -m 700 /etc/yushuhub-upgrade/instances /etc/yushuhub-upgrade/releases /var/lib/yushuhub-upgrade
ln -sfn "$RELEASE" /opt/yushuhub-upgrade-controller/current
[ ! -L /usr/local/sbin/yushuhub-upgrade ] || { echo 'CLI路径为意外链接，停止安装' >&2; exit 1; }
cat > /usr/local/sbin/yushuhub-upgrade <<'WRAPPER'
#!/usr/bin/env bash
exec python3 /opt/yushuhub-upgrade-controller/current/controller.py "$@"
WRAPPER
chmod 755 /usr/local/sbin/yushuhub-upgrade
echo "独立CLI已安装：$REVISION。尚未登记实例或执行迁移。"
