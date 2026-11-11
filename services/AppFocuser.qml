import QtQuick
import Quickshell
import Quickshell.Io
import "../core/RootSearch.js" as RootSearch

// Opening an app that already has a window focuses that window instead of
// starting another instance [D]. Anything that goes wrong on the way (no
// hyprctl, bad JSON, no match) falls back to launching. Each open gets its
// own window lookup, one at a time: a second open (two quick `run` calls
// over IPC) waits for the first lookup instead of stopping it, so neither
// becomes a second instance of an app whose window is already open.
Item {
  id: service
  // The candidate the running lookup is for, and the ones waiting for theirs.
  property var pending: null
  property var queue: []
  signal launchRequested(var candidate)

  function open(candidate) {
    if (!candidate.windowKeys || !candidate.windowKeys.length) {
      service.launchRequested(candidate)
      return
    }
    service.queue = service.queue.concat([candidate])
    service.next()
  }

  // Starts the next lookup once the previous process is gone.
  function next() {
    if (service.pending || clients.running || service.queue.length === 0)
      return
    service.pending = service.queue[0]
    service.queue = service.queue.slice(1)
    clients.running = true
  }

  // The one way a lookup ends: its output (text), or a failure (null).
  function finish(text) {
    var candidate = service.pending
    service.pending = null
    if (!candidate)
      return
    var address = ""
    var minimized = false
    if (text !== null) {
      try {
        var list = JSON.parse(text)
        address = RootSearch.findAppWindow(list, candidate.windowKeys)
        minimized = list.some(function (c) {
          return String(c.address) === address && c.workspace && c.workspace.name === "special:minimized"
        })
      } catch (e) {}
    }
    if (address)
      service.focusWindow(address, minimized)
    else
      service.launchRequested(candidate)
  }

  // Focusing the window is what moves you to its workspace. Hyprland refuses
  // focus to any window while the launcher's layer holds exclusive keyboard
  // focus, and refocuses the previous window when it unmaps, so wait (up to a
  // second) for the "foamy-menu" layer to go before dispatching. The Lua-config
  // dispatcher is tried first and the classic keyword form is the fallback;
  // the dispatch is retried for half a second in case it still lands early.
  // On floating workspaces focus doesn't raise, so the window is then brought
  // to the top the way the dock does it; a window minimized to the dock is
  // first moved back to the workspace in front of the user.
  function focusWindow(address, minimized) {
    Quickshell.execDetached(["bash", "-c", 'for _ in $(seq 20); do' + ' hyprctl layers -j 2>/dev/null | grep -q \'"namespace": *"foamy-menu"\' || break;' + ' sleep 0.05;' + ' done;' + ' if [[ $1 == 1 ]]; then' + ' ws=$(hyprctl activeworkspace -j | jq -r .id);' + ' hyprctl dispatch "hl.dsp.window.move({ workspace = \\"$ws\\", window = \\"address:$0\\" })" >/dev/null 2>&1' + ' || hyprctl dispatch movetoworkspacesilent "$ws,address:$0" >/dev/null 2>&1;' + ' fi;' + ' for _ in 1 2 3 4 5 6 7 8 9 10; do' + ' hyprctl dispatch "hl.dsp.focus({ window = \\"address:$0\\" })" >/dev/null 2>&1' + ' || hyprctl dispatch focuswindow "address:$0" >/dev/null 2>&1;' + ' if [[ $(hyprctl activewindow -j | jq -r .address) == "$0" ]]; then' + ' hyprctl dispatch "hl.dsp.window.alter_zorder({ mode = \\"top\\", window = \\"address:$0\\" })" >/dev/null 2>&1' + ' || hyprctl dispatch alterzorder "top,address:$0" >/dev/null 2>&1;' + ' exit 0;' + ' fi;' + ' sleep 0.05;' + ' done', address, minimized ? "1" : "0"])
  }

  Process {
    id: clients
    // Under timeout, so a stuck hyprctl falls back to launching within 2 s.
    command: ["timeout", "--kill-after=1s", "2s", "hyprctl", "clients", "-j"]
    stdout: StdioCollector {
      onStreamFinished: service.finish(text)
    }
    onExited: function (exitCode) {
      if (exitCode !== 0)
        service.finish(null)
    }
    // After the output and exited() nothing is pending. Without them the
    // command never started: launch. Either way the next lookup can start.
    onRunningChanged: {
      if (running)
        return
      service.finish(null)
      Qt.callLater(service.next)
    }
  }
}
