#!/usr/bin/env python3
"""services/JsonStore.qml in a real Quickshell, offscreen, against real files:
the store that holds favorites, aliases, ranking and calculator history.

- a missing file becomes a new store; an update reaches the file;
- an unreadable file and a file from a newer build are read-only: an update
  is refused and the file keeps its bytes;
- an update made just before the store is destroyed is still written;
- a file another program replaced (atomically) is read again, and the store
  does not write over it;
- a file another program empties (to write it again in place) or removes
  keeps its data in the store, and the store writes nothing over it.

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
MINE = '{"schemaVersion":1,"items":["mine"]}'
REWRITTEN = '{"schemaVersion":1,"items":["mine","more"]}'

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
  property var warnings: ({})
  function check(ok, detail) {
    console.log((ok ? "PASS " : "FOAMY FAIL ") + detail)
  }
  function noted(name, level, text) {
    if (level === "error")
      test.errors[name] = (test.errors[name] || []).concat([text])
    if (level === "warning")
      test.warnings[name] = (test.warnings[name] || []).concat([text])
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
  Services.JsonStore {
    id: emptied
    path: test.dir + "/emptied.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("emptied", level, text)
  }
  Services.JsonStore {
    id: removed
    path: test.dir + "/removed.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("removed", level, text)
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
  // Another program saving the file in place: it empties the file, and
  // writes the new text through the same open file once told to go on.
  Process {
    id: inPlace
    stdinEnabled: true
    command: ["sh", "-c", 'exec 3>"$1"; read -r go; printf "%s" "$2" >&3', "sh", test.dir + "/emptied.json", Quickshell.env("FOAMY_REWRITTEN")]
  }
  Process {
    id: remover
    command: ["rm", "--", test.dir + "/removed.json"]
  }
  function done() {
    console.log("FOAMY DONE")
    Qt.quit()
  }
  function first(store) {
    return store.doc && store.doc.items ? store.doc.items[0] : undefined
  }
  Component.onCompleted: {
    wait.waitFor(function () {
      return fresh.loaded && newer.loaded && watched.loaded && emptied.loaded && removed.loaded && !!test.errors.broken && holder.item && holder.item.loaded
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
      inPlace.running = true
      remover.running = true
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
            test.emptying()
          })
        })
      })
    })
  }
  // Until the store reports the empty file (or reads it as a new one).
  function emptying() {
    wait.waitFor(function () {
      return !!test.warnings.emptied || test.first(emptied) !== "mine"
    }, 10000, function (ok) {
      test.check(ok && test.first(emptied) === "mine" && !emptied.readOnly, "a file another program empties keeps its data in the store: " + JSON.stringify(emptied.doc))
      inPlace.write("go\\n")
      wait.waitFor(function () {
        return !!emptied.doc && emptied.doc.items[1] === "more"
      }, 10000, function (ok) {
        test.check(ok, "the text the other program writes in place is read: " + JSON.stringify(emptied.doc))
        test.removing()
      })
    })
  }
  function removing() {
    wait.waitFor(function () {
      return !!test.warnings.removed || test.first(removed) !== "mine"
    }, 10000, function (ok) {
      test.check(ok && test.first(removed) === "mine", "a file another program removes keeps its data in the store: " + JSON.stringify(removed.doc))
      test.check(removed.update(function (d) {
        d.items.push("after")
      }), "the store takes an update after its file is removed")
      removed.flush()
      test.done()
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
    (stores / "emptied.json").write_text(MINE)
    (stores / "removed.json").write_text(MINE)
    run.env["FOAMY_STORE_DIR"] = str(stores)
    run.env["FOAMY_OUTSIDE"] = OUTSIDE
    run.env["FOAMY_REWRITTEN"] = REWRITTEN
    run.run(timeout=60)
    problems = run.failures()
    # What the files hold once the shell is gone.
    for name, expected in (("broken", BROKEN), ("newer", NEWER), ("watched", OUTSIDE), ("emptied", REWRITTEN)):
        text = (stores / f"{name}.json").read_text()
        if text != expected:
            problems.append(f"{name}.json was written over: {text!r}")
    unload = stores / "unload.json"
    if not unload.exists() or json.loads(unload.read_text()).get("items") != ["kept"]:
        problems.append(f"unload.json lost its last update: {unload.read_text() if unload.exists() else 'missing'!r}")
    removed = stores / "removed.json"
    if not removed.exists() or json.loads(removed.read_text()).get("items") != ["mine", "after"]:
        problems.append(f"removed.json lost its data: {removed.read_text() if removed.exists() else 'missing'!r}")
    if run.host_commands():
        problems.append(f"host commands without a stand-in: {run.host_commands()!r}")
    ok = run.ok and not problems
    summary = "new, unreadable, newer, replaced, emptied and removed files, and a save on unload"
    print(f"{'PASS' if ok else 'FAIL'} json store: {summary if ok else 'see below'}")
    if not ok:
        print("\n".join("    " + line for line in (problems or run.log.splitlines()[-40:])))
        print(f"    log kept at {run.base}")
        return 1
    run.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
