#!/usr/bin/env bash
set -euo pipefail

# Uses a separate Quickshell instance and temporary menu file; briefly opens
# preview windows but never modifies the installed shell or launches actions.
plugin_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
omarchy_dir=${OMARCHY_PATH:-/usr/share/omarchy}
export OMARCHY_PATH="$omarchy_dir"
probe_dir=$(mktemp -d)
trap 'rm -rf -- "$probe_dir"' EXIT
for module in Commons Ui services; do
  ln -s "$omarchy_dir/shell/$module" "$probe_dir/$module"
done
ln -s "$plugin_dir" "$probe_dir/plugin"
cp "$plugin_dir/test-menu.qml" "$probe_dir/shell.qml"
# RC's Apps row launches the dock. Keep a provider-only fixture to exercise
# the menu's shared application library on both supported stock versions.
printf '%s\n' '{"apps":{"label":"Apps","provider":"apps"}}' > "$probe_dir/menu.jsonc"
printf '%s\n' '{"version":1,"bar":{"layout":{"left":[{"id":"foamy.menu","width":360}]}}}' > "$probe_dir/shell.json"
# The stock dispatcher uses a login shell, which can reset PATH. BASH_ENV
# intercepts only this test instance's summon command after login setup.
cat > "$probe_dir/action-stub.sh" <<'STUB'
omarchy-shell() {
  printf '%s\n' "$*" >> "$FOAMY_MENU_TEST_ACTION_LOG"
}
STUB
export BASH_ENV="$probe_dir/action-stub.sh"
export FOAMY_MENU_TEST_ACTION_LOG="$probe_dir/actions.log"
: > "$FOAMY_MENU_TEST_ACTION_LOG"
# Quickshell can report success after its child crashes; require the test result.
timeout 45s quickshell -p "$probe_dir" --no-color 2>&1 | tee "$probe_dir/result.log"
if ! grep -Eq 'RESULT: [0-9]+ integration checks passed' "$probe_dir/result.log"; then
  echo "FAIL: integration test did not finish" >&2
  exit 1
fi
