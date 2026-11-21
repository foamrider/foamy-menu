#!/usr/bin/env python3
"""services/JsonStore.qml in a real Quickshell, offscreen, against real files:
the store that holds favorites, aliases, ranking and calculator history.

- a missing file becomes a new store; an update reaches the file;
- an unreadable file and a file from a newer build are read-only: an update
  is refused and the file keeps its bytes;
- an update made just before the store is destroyed is still written;
- a file another program replaced (atomically) is read again, and the store
  does not write over it.

  tests/json-store.py

Uses the foamy-kit harness (FOAMY_KIT, default ~/GitHub/Personal/foamy-kit).
"""

import json
import os
from pathlib import Path
import sys

PLUGIN = Path(__file__).resolve().parents[1]
KIT = Path(os.environ.get("FOAMY_KIT", Path.home() / "GitHub/Personal/foamy-kit"))
if not os.environ.get("FOAMY_HOST_45"):
    _root = os.environ.get("OMARCHY_TEST_ROOT")
    os.environ["FOAMY_HOST_45"] = str(Path(_root) / "shell") if _root else "/usr/share/omarchy/shell"

BROKEN = "{oops"
NEWER = '{"schemaVersion": 7, "items": ["from a newer build"]}\n'
OUTSIDE = '{"schemaVersion":1,"items":["outside"]}'

SHELL = """import QtQuick
import Quickshell
import Quickshell.Io
import "plugin/services" as Services
import "harness"

ShellRoot {
  id: test
  readonly property string dir: Quickshell.env("FOAMY_STORE_DIR")
  readonly property var migrations: [{
      version: 1,
      name: "init",
      up: function (d) {
        d.items = []
        return d
      }
    }]
  property var errors: ({})
  function check(ok, detail) {
    console.log((ok ? "PASS " : "FOAMY FAIL ") + detail)
  }
  function noted(name, level, text) {
    if (level === "error")
      test.errors[name] = (test.errors[name] || []).concat([text])
  }
  // The text a file holds now.
  function read(view) {
    view.reload()
    return view.text()
  }
  FoamyWait { id: wait }
  Services.JsonStore {
    id: fresh
    path: test.dir + "/missing.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("missing", level, text)
  }
  Services.JsonStore {
    id: broken
    path: test.dir + "/broken.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("broken", level, text)
  }
  Services.JsonStore {
    id: newer
    path: test.dir + "/newer.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("newer", level, text)
  }
  Services.JsonStore {
    id: watched
    path: test.dir + "/watched.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("watched", level, text)
  }
  Loader {
    id: holder
    sourceComponent: Services.JsonStore {
      path: test.dir + "/unload.json"
      migrations: test.migrations
      ready: true
      onMessage: (level, text) => test.noted("unload", level, text)
    }
  }
  FileView {
    id: freshFile
    path: test.dir + "/missing.json"
    blockLoading: true
    printErrors: false
  }
  FileView {
    id: unloadFile
    path: test.dir + "/unload.json"
    blockLoading: true
    printErrors: false
  }
  // Another program saving the file the way editors and sync tools do:
  // a new file, renamed over the old one.
  Process {
    id: editor
    command: ["sh", "-c", 'printf "%s" "$2" > "$1.tmp" && mv "$1.tmp" "$1"', "sh", test.dir + "/watched.json", Quickshell.env("FOAMY_OUTSIDE")]
  }
  function done() {
    console.log("FOAMY DONE")
    Qt.quit()
  }
  Component.onCompleted: {
    wait.waitFor(function () {
      return fresh.loaded && newer.loaded && watched.loaded && !!test.errors.broken && holder.item && holder.item.loaded
    }, 10000, function (ok) {
      test.check(ok, "every store read its file")
      if (!ok)
        return test.done()
      test.check(fresh.update(function (d) {
        d.items.push("a")
      }), "a new store takes an update")
      test.check(broken.readOnly && !broken.update(function (d) {
        d.items = []
      }), "an unreadable file is read-only and refuses an update")
      test.check((test.errors.broken || []).length === 1, "an unreadable file is reported once: " + JSON.stringify(test.errors.broken))
      test.check(newer.readOnly && newer.doc.items[0] === "from a newer build" && !newer.update(function (d) {
        d.items = []
      }), "a file from a newer build is read but refuses an update")
      // The update's save timer dies with the store: only the flush on
      // destruction can write it.
      holder.item.update(function (d) {
        d.items.push("kept")
      })
      holder.active = false
      editor.running = true
      wait.waitFor(function () {
        var saved = JSON.parse(test.read(freshFile) || "{}")
        return saved.schemaVersion === 1 && saved.items && saved.items[0] === "a"
      }, 10000, function (ok) {
        test.check(ok, "the update reaches the new store's file: " + freshFile.text())
        wait.waitFor(function () {
          return test.read(unloadFile).indexOf("kept") >= 0
        }, 5000, function (ok) {
          test.check(ok, "an update made just before the store goes is written: " + unloadFile.text())
          wait.waitFor(function () {
            return watched.doc && watched.doc.items[0] === "outside"
          }, 10000, function (ok) {
            test.check(ok, "a file replaced by another program is read again: " + JSON.stringify(watched.doc))
            test.done()
          })
        })
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

    run = harness.Run("4.5", SHELL, plugin=PLUGIN, prefix="foamy-menu-store-")
    stores = run.base / "stores"
    stores.mkdir()
    (stores / "broken.json").write_text(BROKEN)
    (stores / "newer.json").write_text(NEWER)
    (stores / "watched.json").write_text('{"schemaVersion":1,"items":["before"]}')
    run.env["FOAMY_STORE_DIR"] = str(stores)
    run.env["FOAMY_OUTSIDE"] = OUTSIDE
    run.run(timeout=60)
    problems = run.failures()
    # What the files hold once the shell is gone.
    for name, expected in (("broken", BROKEN), ("newer", NEWER), ("watched", OUTSIDE)):
        text = (stores / f"{name}.json").read_text()
        if text != expected:
            problems.append(f"{name}.json was written over: {text!r}")
    unload = stores / "unload.json"
    if not unload.exists() or json.loads(unload.read_text()).get("items") != ["kept"]:
        problems.append(f"unload.json lost its last update: {unload.read_text() if unload.exists() else 'missing'!r}")
    if run.host_commands():
        problems.append(f"host commands without a stand-in: {run.host_commands()!r}")
    ok = run.ok and not problems
    summary = "new, unreadable, newer and replaced files, and a save on unload"
    print(f"{'PASS' if ok else 'FAIL'} json store: {summary if ok else 'see below'}")
    if not ok:
        print("\n".join("    " + line for line in (problems or run.log.splitlines()[-40:])))
        print(f"    log kept at {run.base}")
        return 1
    run.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
