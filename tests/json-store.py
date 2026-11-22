#!/usr/bin/env python3
"""services/JsonStore.qml in a real Quickshell, offscreen, against real files:
the store that holds favorites, aliases, ranking and calculator history.

- a missing file becomes a new store; an update reaches the file;
- an unusable file (not JSON, not an object, a bad schemaVersion, a failed
  migration, a mistyped part, no read permission) and a file from a newer
  build are read-only: an update is refused and the file keeps its bytes;
  the unusable file still gives the store an empty document; removing it,
  or the newer one, makes a new store, and an unusable file another program
  empties to fix it in place stays read-only until the fixed text is read;
- a file without one of its parts gets an empty one and takes updates;
- an update made just before the store is destroyed is still written;
- a file another program replaced (atomically) is read again, and the store
  does not write over it;
- a file another program empties (to write it again in place) or removes
  keeps its data in the store, and the store writes nothing over it.

Then Backend.qml over such stores: it gets ready with an unreadable
calculator.json and a settings.json without its general settings, a change
the calculator store refuses fails with the reason, the zoom is saved, and
long searches and long search terms stay out of frecency.json.

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

NEWER = '{"schemaVersion": 7, "items": ["from a newer build"]}\n'
OUTSIDE = '{"schemaVersion":1,"items":["outside"]}'
MINE = '{"schemaVersion":1,"items":["mine"]}'
PARTLESS = '{"schemaVersion": 1}'
REWRITTEN = '{"schemaVersion":1,"items":["mine","more"]}'
MENDED = '{"schemaVersion":1,"items":["fixed by hand"]}'
# Files the store cannot use as they are; each must stay as it is.
UNUSABLE = {
    "broken": "{oops",
    "notobject": "[1, 2]",
    "badversion": '{"schemaVersion": "x", "items": []}',
    "throws": '{"explode": true}',
    "wronglist": '{"schemaVersion": 1, "items": {"a": 1}}',
    "denied": MINE,
}

SHELL = """import QtQuick
import Quickshell
import Quickshell.Io
import "plugin/services" as Services
import "harness"

ShellRoot {
  id: test
  readonly property string dir: Quickshell.env("FOAMY_STORE_DIR")
  readonly property var unusable: JSON.parse(Quickshell.env("FOAMY_UNUSABLE"))
  readonly property var migrations: [{
      version: 1,
      name: "init",
      up: function (d) {
        if (d.explode)
          throw new Error("cannot migrate this document")
        d.items = []
        return d
      }
    }]
  property var warnings: ({})
  function check(ok, detail) {
    console.log((ok ? "PASS " : "FOAMY FAIL ") + detail)
  }
  function noted(name, level, text) {
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
  Instantiator {
    id: unusableStores
    model: test.unusable
    delegate: Services.JsonStore {
      required property string modelData
      // The errors this store reported.
      property var reported: []
      path: test.dir + "/" + modelData + ".json"
      migrations: test.migrations
      ready: true
      onMessage: (level, text) => {
        if (level === "error")
          reported = reported.concat([text])
      }
    }
  }
  function store(name) {
    return unusableStores.objectAt(test.unusable.indexOf(name))
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
    id: partless
    path: test.dir + "/partless.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("partless", level, text)
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
  Services.JsonStore {
    id: mended
    path: test.dir + "/mended.json"
    migrations: test.migrations
    ready: true
    onMessage: (level, text) => test.noted("mended", level, text)
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
  Process {
    id: fixer
    command: ["rm", "--", test.dir + "/broken.json"]
  }
  Process {
    id: newerRemover
    command: ["rm", "--", test.dir + "/newer.json"]
  }
  // An editor fixing an unusable file in place.
  Process {
    id: mender
    stdinEnabled: true
    command: ["sh", "-c", 'exec 3>"$1"; read -r go; printf "%s" "$2" >&3', "sh", test.dir + "/mended.json", Quickshell.env("FOAMY_MENDED")]
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
      return fresh.loaded && newer.loaded && watched.loaded && partless.loaded && emptied.loaded && removed.loaded && mended.loaded && holder.item && holder.item.loaded && test.unusable.every(function (name) {
        return test.store(name).loaded || test.store(name).reported.length > 0
      })
    }, 10000, function (ok) {
      test.check(ok, "every store read its file")
      if (!ok)
        return test.done()
      test.check(fresh.update(function (d) {
        d.items.push("a")
      }), "a new store takes an update")
      for (var i = 0; i < test.unusable.length; i++) {
        var name = test.unusable[i]
        var store = test.store(name)
        test.check(store.readOnly && store.lastError !== "" && !store.update(function (d) {
          d.items = ["lost"]
        }), name + ": an unusable file is read-only and refuses an update")
        test.check(store.loaded && !!store.doc && Array.isArray(store.doc.items) && store.doc.items.length === 0, name + ": an unusable file leaves the store loaded with an empty document: " + JSON.stringify(store.doc))
        test.check(store.reported.length === 1, name + ": an unusable file is reported once: " + JSON.stringify(store.reported))
      }
      test.check(newer.readOnly && newer.doc.items[0] === "from a newer build" && !newer.update(function (d) {
        d.items = []
      }), "a file from a newer build is read but refuses an update")
      test.check(mended.readOnly && mended.lastError !== "", "an unreadable file to fix in place is read-only")
      test.check(!partless.readOnly && partless.lastError === "" && JSON.stringify(partless.doc.items) === "[]" && (test.warnings.partless || []).length === 1, "a file without its items gets an empty list: " + JSON.stringify(partless.doc) + " " + JSON.stringify(test.warnings.partless))
      test.check(partless.update(function (d) {
        d.items.push("x")
      }), "a file without its items takes an update")
      partless.flush()
      // The update's save timer dies with the store: only the flush on
      // destruction can write it.
      holder.item.update(function (d) {
        d.items.push("kept")
      })
      holder.active = false
      editor.running = true
      inPlace.running = true
      remover.running = true
      fixer.running = true
      newerRemover.running = true
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
      var broken = test.store("broken")
      wait.waitFor(function () {
        return broken.loaded && !broken.readOnly && !newer.readOnly
      }, 10000, function (ok) {
        test.check(ok && broken.lastError === "" && broken.doc.items.length === 0, "removing an unreadable file makes a new store: " + JSON.stringify(broken.doc) + " " + broken.lastError)
        test.check(ok && newer.lastError === "" && newer.doc.items.length === 0 && newer.update(function (d) {
          d.items.push("new")
        }), "removing a file from a newer build makes a new store: " + JSON.stringify(newer.doc))
        newer.flush()
        test.mending()
      })
    })
  }
  // Until the store reports the empty file (or reads it as a new one).
  function mending() {
    mender.running = true
    wait.waitFor(function () {
      return !!test.warnings.mended || !mended.readOnly
    }, 10000, function (ok) {
      test.check(ok && mended.readOnly && mended.lastError !== "", "an unusable file another program empties to write it in place stays read-only: " + JSON.stringify(mended.doc) + " " + mended.lastError)
      mender.write("go\\n")
      wait.waitFor(function () {
        return !!mended.doc && mended.doc.items[0] === "fixed by hand"
      }, 10000, function (ok) {
        test.check(ok && !mended.readOnly && mended.lastError === "", "the fixed text written in place is read: " + JSON.stringify(mended.doc) + " " + mended.lastError)
        // Each later change in the directory reads denied.json again.
        test.check(test.unusable.every(function (name) {
          return test.store(name).reported.length === 1
        }), "each unusable file is still reported once")
        test.done()
      })
    })
  }
}
"""

BACKEND_SHELL = """import QtQuick
import Quickshell
import Quickshell.Io
import "plugin" as Foamy
import "harness"

ShellRoot {
  id: test
  // Longer than any listed value (Scopes.MAX_TEXT, 512), shorter than
  // what a search engine takes.
  readonly property string longText: Array(121).join("rust async ")
  function check(ok, detail) {
    console.log((ok ? "PASS " : "FOAMY FAIL ") + detail)
  }
  function call(method, data) {
    return backend.callSync(method, data === undefined ? null : data)
  }
  FoamyWait { id: wait }
  Foamy.Backend {
    id: backend
    version: "0.0.0-store"
    // No exchange rates: with no rates cached the calculator downloads them.
    settingsEntry: ({
        currencyRates: false
      })
  }
  FileView {
    id: browsed
    path: Quickshell.env("FOAMY_BROWSER_FILE")
    blockLoading: true
    printErrors: false
  }
  function done() {
    console.log("FOAMY DONE")
    Qt.quit()
  }
  Component.onCompleted: {
    wait.waitFor(function () {
      return backend.ready
    }, 15000, function (ok) {
      test.check(ok, "the backend is ready with an unreadable calculator.json and no general settings in settings.json")
      test.stores()
    })
  }
  function stores() {
    var general = test.call("settings.getGeneralSettings")
    test.check(general.ok && general.data.uiZoom === 1, "general settings fall back to the defaults: " + JSON.stringify(general))
    var zoom = test.call("settings.updateGeneralSettings", {
      uiZoom: 1.5
    })
    test.check(zoom.ok && zoom.data.uiZoom === 1.5, "the zoom is saved: " + JSON.stringify(zoom))
    var history = test.call("calculator.historyGetAll")
    test.check(history.ok && Array.isArray(history.data) && history.data.length === 0, "calculator history is empty: " + JSON.stringify(history))
    var health = test.call("system.healthDatabase")
    test.check(health.ok && health.data.settings.loaded && !health.data.settings.readOnly && health.data.settings.error === "", "the settings store is usable: " + JSON.stringify(health))
    var cleared = test.call("calculator.historyDeleteAll")
    test.check(!cleared.ok && cleared.error.indexOf("calculator.json is read-only: unreadable ") === 0, "clearing the history of an unreadable calculator.json fails with the reason: " + JSON.stringify(cleared))
    // The commands and scope files are read apart from the stores.
    wait.waitFor(function () {
      return !!backend.candidatesById["builtin:calculator-history"] && backend.scopes.some(function (s) {
        return s.id === "duckduckgo" && s.history === true
      })
    }, 10000, function (ok) {
      test.check(ok, "the commands are listed and DuckDuckGo keeps its searches")
      var reset = test.call("rootSearch.performAction", {
        id: "builtin:calculator-history",
        action: "reset-ranking",
        query: ""
      })
      test.check(reset.ok && reset.data.toast.style === "success", "a change a usable store takes still succeeds: " + JSON.stringify(reset))
      test.searches()
    })
  }
  function searches() {
    var long = test.call("rootSearch.performAction", {
      id: "scope-query:duckduckgo",
      action: "open",
      query: test.longText
    })
    test.check(long.ok && long.data.close === true, "a long search runs: " + JSON.stringify(long).slice(0, 200))
    var short = test.call("rootSearch.performAction", {
      id: "scope-query:duckduckgo",
      action: "open",
      query: "pasta"
    })
    test.check(short.ok && short.data.close === true, "a short search runs: " + JSON.stringify(short))
    var longSaved = test.call("frecency.get", {
      id: "scope-item:duckduckgo:" + test.longText.trim()
    })
    test.check(longSaved.ok && longSaved.data === null, "a search longer than 512 characters is not saved")
    var shortSaved = test.call("frecency.get", {
      id: "scope-item:duckduckgo:pasta"
    })
    test.check(shortSaved.ok && !!shortSaved.data, "a short search is saved")
    test.call("frecency.visit", {
      id: "builtin:calculator-history",
      query: test.longText
    })
    test.call("frecency.visit", {
      id: "builtin:calculator-history",
      query: "calc"
    })
    var visited = test.call("frecency.get", {
      id: "builtin:calculator-history"
    })
    test.check(visited.ok && !!visited.data && JSON.stringify(visited.data.searchTerms.map(function (t) {
      return t.term
    })) === '["calc"]', "a visit keeps a short search term and drops a long one: " + JSON.stringify(visited.data).slice(0, 200))
    var recent = test.call("rootSearch.getSearchHistory")
    test.check(recent.ok && JSON.stringify(recent.data) === '["calc"]', "search history keeps a short query and drops a long one: " + JSON.stringify(recent.data).slice(0, 200))
    // The searches run detached; both reach the browser stand-in.
    wait.waitFor(function () {
      browsed.reload()
      return browsed.text().split("\\n").length >= 3
    }, 10000, function (ok) {
      // In either order: each stand-in appends when it gets to run.
      var urls = browsed.text().split("\\n")
      test.check(ok && urls.some(function (url) {
        return url.indexOf(encodeURIComponent(test.longText.trim())) >= 0
      }) && urls.indexOf("https://duckduckgo.com/?q=pasta") >= 0, "both searches open in the browser: " + browsed.text().slice(0, 200))
      test.done()
    })
  }
}
"""

BROWSER = '#!/bin/sh\nprintf "%s\\n" "$@" >> "$FOAMY_BROWSER_FILE"\n'
# Every fetch the backend starts: the first line of its request is logged and
# none goes out, so a download fails the run.
CURL = '#!/bin/sh\nhead -n 1 >> "$FOAMY_CURL_FILE"\nexit 7\n'
NO_GENERAL = '{"schemaVersion": 1, "commands": {}}\n'
NOT_A_DOCUMENT = "[]\n"


def store_run(harness):
    run = harness.Run("4.5", SHELL, plugin=PLUGIN, prefix="foamy-menu-store-")
    stores = run.base / "stores"
    stores.mkdir()
    for name, text in UNUSABLE.items():
        (stores / f"{name}.json").write_text(text)
    (stores / "denied.json").chmod(0)
    (stores / "newer.json").write_text(NEWER)
    (stores / "watched.json").write_text('{"schemaVersion":1,"items":["before"]}')
    (stores / "emptied.json").write_text(MINE)
    (stores / "partless.json").write_text(PARTLESS)
    (stores / "removed.json").write_text(MINE)
    (stores / "mended.json").write_text(UNUSABLE["broken"])
    run.env["FOAMY_STORE_DIR"] = str(stores)
    run.env["FOAMY_OUTSIDE"] = OUTSIDE
    run.env["FOAMY_REWRITTEN"] = REWRITTEN
    run.env["FOAMY_MENDED"] = MENDED
    run.env["FOAMY_UNUSABLE"] = json.dumps(list(UNUSABLE))
    run.run(timeout=60)
    (stores / "denied.json").chmod(0o600)
    problems = run.failures()
    # What the files hold once the shell is gone.
    expected = {name: text for name, text in UNUSABLE.items() if name != "broken"}
    expected.update({"watched": OUTSIDE, "emptied": REWRITTEN, "mended": MENDED})
    for name, text in expected.items():
        found = (stores / f"{name}.json").read_text()
        if found != text:
            problems.append(f"{name}.json was written over: {found!r}")
    for name, items in (
        ("unload", ["kept"]),
        ("removed", ["mine", "after"]),
        ("broken", []),
        ("partless", ["x"]),
        ("newer", ["new"]),
    ):
        path = stores / f"{name}.json"
        found = path.read_text() if path.exists() else "missing"
        try:
            ok = json.loads(found).get("items") == items
        except ValueError:
            ok = False
        if not ok:
            problems.append(f"{name}.json should hold the items {items!r}: {found!r}")
    return run, problems, "unusable, newer, replaced, emptied and removed files, and a save on unload"


def backend_run(harness):
    run = harness.Run(
        "4.5",
        BACKEND_SHELL,
        plugin=PLUGIN,
        prefix="foamy-menu-store-",
        fakebin={"omarchy-launch-browser": BROWSER, "curl": CURL},
    )
    home = Path(run.env["HOME"])
    db = Path(run.env.get("XDG_DATA_HOME") or home / ".local/share") / "foamy-menu/db"
    db.mkdir(parents=True)
    (db / "settings.json").write_text(NO_GENERAL)
    (db / "calculator.json").write_text(NOT_A_DOCUMENT)
    scopes = Path(run.env.get("XDG_CONFIG_HOME") or home / ".config") / "foamy-menu/scopes"
    scopes.mkdir(parents=True)
    (scopes / "duckduckgo.json").write_text(json.dumps({"id": "duckduckgo", "history": True}))
    run.env["FOAMY_BROWSER_FILE"] = str(run.base / "browsed")
    fetched = run.base / "fetched"
    run.env["FOAMY_CURL_FILE"] = str(fetched)
    run.run(timeout=60)
    problems = run.failures()
    if fetched.exists():
        problems.append(f"the backend started a download: {fetched.read_text()!r}")
    found = (db / "calculator.json").read_text()
    if found != NOT_A_DOCUMENT:
        problems.append(f"calculator.json was written over: {found!r}")
    settings = json.loads((db / "settings.json").read_text())
    if settings.get("commands") != {} or settings.get("general", {}).get("uiZoom") != 1.5:
        problems.append(f"settings.json does not hold the zoom and its commands: {settings!r}")
    frecency = db / "frecency.json"
    if not frecency.exists() or "rust async" in frecency.read_text():
        problems.append("frecency.json is missing or holds the long search")
    return run, problems, "ready over unusable and partless stores; refused changes fail; long searches are not saved"


def main():
    if not (KIT / "preview/harness.py").exists():
        print(f"SKIP: foamy-kit harness not found at {KIT} (set FOAMY_KIT)")
        return 0
    sys.path.insert(0, str(KIT / "preview"))
    import harness

    status = 0
    for scene in (store_run, backend_run):
        run, problems, summary = scene(harness)
        if run.host_commands():
            problems.append(f"host commands without a stand-in: {run.host_commands()!r}")
        ok = run.ok and not problems
        print(f"{'PASS' if ok else 'FAIL'} json store: {summary if ok else 'see below'}")
        if not ok:
            print("\n".join("    " + line for line in (problems or run.log.splitlines()[-40:])))
            print(f"    log kept at {run.base}")
            status = 1
        else:
            run.cleanup()
    return status


if __name__ == "__main__":
    raise SystemExit(main())
