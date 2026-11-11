#!/usr/bin/env bash
# Foamy Menu tests. Safe to run anywhere: offscreen, in temporary HOME/XDG
# directories, with every omarchy-* command stubbed, so it never touches the
# desktop or its shell. Extra arguments go to tests/runtime.py
# (e.g. --shots DIR; --host both adds 4.0 when FOAMY_HOST_40 is set).
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
# Two node tests run their QML in a real Quickshell (offscreen, in their own
# HOME and XDG directories) and skip without one; the runtimes below need it.
OMACAST_QML_RUNNER=${OMACAST_QML_RUNNER:-$(command -v qs || true)}
export OMACAST_QML_RUNNER
node --test tests/*.test.js
python3 -I tests/runtime.py "$@"
python3 -I tests/launcher.py "$@"
