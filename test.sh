#!/usr/bin/env bash
# Foamy Menu tests. Safe to run anywhere: offscreen, in temporary HOME/XDG
# directories, with every omarchy-* command stubbed, so it never touches the
# desktop or its shell. Extra arguments go to tests/runtime.py
# (e.g. --host 4.5, --shots DIR).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
python3 -I tests/runtime.py "$@"
