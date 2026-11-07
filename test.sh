#!/usr/bin/env bash
# Foamy Menu tests. Safe to run anywhere: offscreen, in temporary HOME/XDG
# directories, with every omarchy-* command stubbed, so it never touches the
# desktop or its shell. Extra arguments go to tests/runtime.py
# (e.g. --shots DIR; --host both adds 4.0 when FOAMY_HOST_40 is set).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
node --test tests/*.test.js
python3 -I tests/runtime.py "$@"
python3 -I tests/launcher.py "$@"
