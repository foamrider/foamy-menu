#!/usr/bin/env python3
"""services/AppFocuser.qml in a real Quickshell, offscreen, against a fake
hyprctl: three quick opens (an app with an open window twice, as two quick
`foamy-menu run` calls would, then an app without one) each get their own
window lookup. The open window is focused twice and nothing of it is
launched; only the app without a window launches. Focus waits while the
launcher's layer (its namespace read from ui/LauncherWindow.qml) is still
mapped. Then three lookups that fail (output that is not JSON, hyprctl
exiting 1, hyprctl hanging) each launch the app once, and the hung hyprctl
is ended by the lookup's deadline.

  tests/app-focuser.py

Uses the foamy-kit harness (FOAMY_KIT, default ~/GitHub/Personal/foamy-kit).
"""

import os
from pathlib import Path
import re
import sys

PLUGIN = Path(__file__).resolve().parents[1]
KIT = Path(os.environ.get("FOAMY_KIT", Path.home() / "GitHub/Personal/foamy-kit"))
if not os.environ.get("FOAMY_HOST_45"):
    _root = os.environ.get("OMARCHY_TEST_ROOT")
    os.environ["FOAMY_HOST_45"] = str(Path(_root) / "shell") if _root else "/usr/share/omarchy/shell"

# Every call is logged. `clients -j` answers slowly, so the later opens
# arrive while the first lookup runs; lookups run one at a time, so the
# count of logged calls says which one this is. Calls 4-6 fail: output that
# is not JSON, exit 1, and a hang (its pid is recorded). The first three
# `layers -j` calls, across both focus scripts, show the launcher's layer
# still mapped; later ones show it gone. Focus lands at once.
HYPRCTL = """#!/bin/sh
printf '%s\\n' "$*" >> "$FOAMY_HYPRCTL_LOG"
calls=$(grep -c "^$1" "$FOAMY_HYPRCTL_LOG")
case "$1" in
  clients)
    case $calls in
      4) printf 'not json\\n' ;;
      5) exit 1 ;;
      6) echo $$ > "$FOAMY_HYPRCTL_PIDS"; exec sleep 300 ;;
      *) sleep 0.4; printf '[{"address":"0xabc","class":"firefox","mapped":true,"focusHistoryID":1,"workspace":{"id":1,"name":"1"}}]\\n' ;;
    esac ;;
  layers)
    if [ "$calls" -le 3 ]; then
      printf '{"M":{"levels":{"3":[{"namespace": "%s"}]}}}\\n' "$FOAMY_LAYER_NAMESPACE"
    else
      printf '{}\\n'
    fi ;;
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
  function idle() { return !focuser.pending && focuser.queue.length === 0 }
  function done() {
    console.log("FOAMY DONE")
    Qt.quit()
  }
  Component.onCompleted: {
    var firefox = { id: "app:firefox", windowKeys: ["firefox"] }
    focuser.open(firefox)
    focuser.open(firefox)
    focuser.open({ id: "app:signal", windowKeys: ["signal-desktop"] })
    wait.waitFor(function() { return test.idle() && test.launched.length > 0 }, 20000, function(ok) {
      console.log((ok ? "FOAMY LAUNCHED " : "FOAMY FAIL lookups never ended: ") + JSON.stringify(test.launched))
      if (!ok)
        return test.done()
      // The next three lookups fail; each must launch the app once.
      focuser.open(firefox)
      focuser.open(firefox)
      focuser.open(firefox)
      wait.waitFor(function() { return test.idle() && test.launched.length === 4 }, 20000, function(ok) {
        console.log((ok ? "FOAMY FALLBACKS " : "FOAMY FAIL failed lookups never ended: ") + JSON.stringify(test.launched))
        test.done()
      })
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

    # The fake's input, not an assertion on the source: the focuser must
    # wait for whatever namespace the launcher window really maps.
    window = (PLUGIN / "ui/LauncherWindow.qml").read_text()
    found = re.search(r'^\s*WlrLayershell\.namespace:\s*"([^"]+)"\s*$', window, re.M)
    if not found:
        print("FAIL app focuser: the launcher window no longer names its layer")
        return 1
    # README documents the namespace for Hyprland layer rules.
    if found.group(1) != "foamy-menu":
        print(f"FAIL app focuser: the launcher's layer namespace is {found.group(1)!r}, not the documented foamy-menu")
        return 1

    run = harness.Run("4.5", SHELL, plugin=PLUGIN, prefix="foamy-menu-focuser-", fakebin={"hyprctl": HYPRCTL})
    log = run.base / "hyprctl.log"
    log.write_text("")
    pids = run.base / "hyprctl.pids"
    run.env["FOAMY_HYPRCTL_LOG"] = str(log)
    run.env["FOAMY_HYPRCTL_PIDS"] = str(pids)
    run.env["FOAMY_LAYER_NAMESPACE"] = found.group(1)
    run.run(timeout=60)
    problems = run.failures()

    def marked(marker):
        return next((line.split(marker, 1)[1] for line in run.log.splitlines() if marker in line), None)

    launched = marked("FOAMY LAUNCHED ")
    if launched != '["app:signal"]':
        problems.append(f"launched {launched}, expected only app:signal")
    failed = marked("FOAMY FALLBACKS ")
    if failed != '["app:signal","app:firefox","app:firefox","app:firefox"]':
        problems.append(f"after three failed lookups launched {failed}, expected app:firefox once for each")

    # focusWindow runs detached; wait for both focus dispatches to land.
    def calls():
        return log.read_text().splitlines()

    focus = 'dispatch hl.dsp.focus({ window = "address:0xabc" })'
    harness.wait_for(lambda: calls().count(focus) >= 2, 10)
    if calls().count("clients -j") != 6:
        problems.append(f"expected one window lookup per open: {calls()!r}")
    if calls().count(focus) != 2:
        problems.append(f"expected the open window focused twice: {calls()!r}")
    # The fake shows the layer mapped for three `layers -j` calls, so a focus
    # that waited for it comes after at least four of them.
    before = calls()[: calls().index(focus)] if focus in calls() else calls()
    if before.count("layers -j") < 4:
        problems.append(f"focus did not wait for the {found.group(1)} layer to go: {calls()!r}")
    hung = pids.read_text().strip() if pids.exists() else ""
    if not hung.isdigit():
        problems.append("the hung lookup never started")
    elif not harness.wait_for(lambda: not Path(f"/proc/{hung}").exists(), 5):
        problems.append(f"the hung hyprctl {hung} outlived the lookup's deadline")
        os.kill(int(hung), 9)
    if run.host_commands():
        problems.append(f"host commands without a stand-in: {run.host_commands()!r}")
    ok = run.ok and not problems
    summary = "three opens, two focused after the layer went, one launched; three failed lookups launched"
    print(f"{'PASS' if ok else 'FAIL'} app focuser: {summary if ok else 'see below'}")
    if not ok:
        print("\n".join("    " + line for line in (problems or run.log.splitlines()[-40:])))
        print(f"    log kept at {run.base}")
        return 1
    run.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
