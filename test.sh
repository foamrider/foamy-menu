#!/usr/bin/env bash
set -euo pipefail

# Uses a separate Quickshell instance and temporary menu file; briefly opens
# preview windows but never modifies the installed shell or launches actions.
plugin_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
omarchy_dir=${OMARCHY_PATH:-/usr/share/omarchy}
probe_dir=$(mktemp -d)
trap 'rm -rf -- "$probe_dir"' EXIT
for module in Commons Ui services; do
  ln -s "$omarchy_dir/shell/$module" "$probe_dir/$module"
done
ln -s "$plugin_dir" "$probe_dir/plugin"
cp "$plugin_dir/test-menu.qml" "$probe_dir/shell.qml"
printf '{}\n' > "$probe_dir/menu.jsonc"
printf '%s\n' '{"version":1,"bar":{"layout":{"left":[{"id":"foamy.menu","width":360}]}}}' > "$probe_dir/shell.json"
timeout 20s quickshell -p "$probe_dir" --no-color
