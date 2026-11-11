#!/bin/bash
# foamy-menu's own tests; tests/validate.sh runs this after the linters, and
# ./test.sh runs it with no options.
#   --ci    no Quickshell, no Omarchy host: the node tests (the two that need
#           Quickshell skip themselves) and the bundled helper through them
#   --fast  skip the offscreen Quickshell runtimes
# Everything runs offscreen in temporary HOME/XDG directories with stubbed
# omarchy-* commands; nothing reaches the desktop or its shell.
set -uo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1
ci=0 fast=0
for arg in "$@"; do
  case $arg in
    --ci) ci=1 ;;
    --fast) fast=1 ;;
    *)
      echo "suite.sh: unknown argument $arg" >&2
      exit 2
      ;;
  esac
done
status=0
run() {
  echo "== $*"
  "$@" || status=1
}
skip() { echo "SKIP $*"; }
kit=${FOAMY_KIT:-$HOME/GitHub/Personal/foamy-kit}

# The loading-feedback and real-import guard tests run their QML in a real
# Quickshell and skip without one.
if ((ci)); then
  unset OMACAST_QML_RUNNER
else
  OMACAST_QML_RUNNER=${OMACAST_QML_RUNNER:-$(command -v qs || true)}
  export OMACAST_QML_RUNNER
fi
run node --test tests/*.test.js
qemu=$(command -v qemu-aarch64-static || command -v qemu-aarch64 || true)
if [[ -n $qemu ]]; then
  FOAMY_HELPER="[\"$qemu\", \"$PWD/bin/aarch64/foamy-menu-search\"]" \
    run node --test tests/native-search.test.js tests/search-integration.test.js tests/ssh-hosts.test.js tests/steam-games.test.js
else
  skip "the aarch64 helper: no qemu-aarch64"
fi
if ((ci || fast)); then
  skip "tests/runtime.py, launcher.py, app-focuser.py and the kit's i18n_runtime.py: offscreen Quickshell"
elif [[ ! -f $kit/preview/harness.py ]]; then
  skip "the runtimes: foamy-kit not found at $kit (set FOAMY_KIT)"
  status=1
else
  run python3 -I tests/runtime.py
  run python3 -I tests/launcher.py
  run python3 -I tests/app-focuser.py
  run python3 -I "$kit/preview/i18n_runtime.py" .
fi
exit $status
