#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -gt 0 ]; then
  exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/delivery.py" install "$@"
fi
echo '使用已核验的固定发行包：install-controller.sh --archive PACKAGE --sha256 EXPECTED_SHA --revision FULL_SHA [--apply]。默认只读计划；不登记实例或迁移业务。'
exit 0
