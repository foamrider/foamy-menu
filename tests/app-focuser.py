#!/usr/bin/env python3
"""services/AppFocuser.qml in a real Quickshell, offscreen, against a fake
hyprctl: three quick opens (an app with an open window twice, as two quick
`foamy-menu run` calls would, then an app without one) each get their own
window lookup. The open window is focused twice and nothing of it is
launched; only the app without a window launches.

  tests/app-focuser.py

Uses the foamy-kit harness (FOAMY_KIT, default ~/GitHub/Personal/foamy-kit).
"""
import os
from pathlib import Path
import sys

PLUGIN = Path(__file__).resolve().parents[1]
KIT = Path(os.environ.get("FOAMY_KIT", Path.home() / "GitHub/Personal/foamy-kit"))
if not os.environ.get("FOAMY_HOST_45"):
    _root = os.environ.get("OMARCHY_TEST_ROOT")
    os.environ["FOAMY_HOST_45"] = str(Path(_root) / "shell") if _root else "/usr/share/omarchy/shell"

# Every call is logged. `clients -j` answers slowly, so the later opens
# arrive while the first lookup runs. Focus lands at once.
HYPRCTL = """#!/bin/sh
printf '%s\\n' "$*" >> "$FOAMY_HYPRCTL_LOG"
case "$1" in
  clients) sleep 0.4; printf '[{"address":"0xabc","class":"firefox","mapped":true,"focusHistoryID":1,"workspace":{"id":1,"name":"1"}}]\\n' ;;
  layers) printf '{}\\n' ;;
  activewindow) printf '{"address":"0xabc"}\\n' ;;
  activeworkspace) printf '{"id":1}\\n' ;;
esac
exit 0
"""

SHELL = """import QtQuick
import Quickshell
import "plugin/services" as Services
import "harness"

ShellRoot {
  id: test
  property var launched: []
  FoamyWait { id: wait }
  Services.AppFocuser {
    id: focuser
    onLaunchRequested: function(candidate) { test.launched = test.launched.concat([candidate.id]) }
  }
  Component.onCompleted: {
    var firefox = { id: "app:firefox", windowKeys: ["firefox"] }
    focuser.open(firefox)
    focuser.open(firefox)
    focuser.open({ id: "app:signal", windowKeys: ["signal-desktop"] })
    wait.waitFor(function() { return !focuser.pending && focuser.queue.length === 0 && test.launched.length > 0 }, 20000, function(ok) {
      console.log((ok ? "FOAMY LAUNCHED " : "FOAMY FAIL lookups never ended: ") + JSON.stringify(test.launched))
      console.log("FOAMY DONE")
      Qt.quit()
    })
  }
}
"""


def main():
    if not (KIT / "preview/harness.py").exists():
        print(f"SKIP: foamy-kit harness not found at {KIT} (set FOAMY_KIT)")
        return 0
    sys.path.insert(0, str(KIT / "preview"))
    import harness

    run = harness.Run("4.5", SHELL, plugin=PLUGIN, prefix="foamy-menu-focuser-", fakebin={"hyprctl": HYPRCTL})
    log = run.base / "hyprctl.log"
    log.write_text("")
    run.env["FOAMY_HYPRCTL_LOG"] = str(log)
    run.run(timeout=40)
    problems = run.failures()
    launched = next((line.split("FOAMY LAUNCHED ", 1)[1] for line in run.log.splitlines() if "FOAMY LAUNCHED " in line), None)
    if launched != '["app:signal"]':
        problems.append(f"launched {launched}, expected only app:signal")

    # focusWindow runs detached; wait for both focus dispatches to land.
    def calls():
        return log.read_text().splitlines()

    focus = 'dispatch hl.dsp.focus({ window = "address:0xabc" })'
    harness.wait_for(lambda: calls().count(focus) >= 2, 10)
    if calls().count("clients -j") != 3:
        problems.append(f"expected one window lookup per open: {calls()!r}")
    if calls().count(focus) != 2:
        problems.append(f"expected the open window focused twice: {calls()!r}")
    if run.host_commands():
        problems.append(f"host commands without a stand-in: {run.host_commands()!r}")
    ok = run.ok and not problems
    print(f"{'PASS' if ok else 'FAIL'} app focuser: {'three opens, two focused, one launched' if ok else 'see below'}")
    if not ok:
        print("\n".join("    " + line for line in (problems or run.log.splitlines()[-40:])))
        print(f"    log kept at {run.base}")
        return 1
    run.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
