#!/usr/bin/env bash
# Foamy Menu tests: tests/suite.sh (also run by tests/validate.sh). Safe to
# run anywhere: offscreen, in temporary HOME/XDG directories, with every
# omarchy-* command stubbed, so it never touches the desktop or its shell.
# --fast skips the offscreen runtimes, --ci needs no Quickshell. For
# screenshots run tests/runtime.py or tests/launcher.py with --shots DIR.
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/tests/suite.sh" "$@"
