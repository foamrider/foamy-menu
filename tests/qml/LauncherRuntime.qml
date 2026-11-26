import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "plugin" as Foamy
import "plugin/services" as FoamyServices
import "plugin/core/Fetch.js" as Fetch
import "plugin/core/Scopes.js" as Scopes

ShellRoot {
  id: test
  property int stage: 0
  property int checks: 0
  property int attempts: 0
  property bool capturing: false
  readonly property var launcher: menu.launcherItem
  readonly property var backend: launcher.backendApi
  readonly property var view: launcher.window
  // The light run picks Norwegian under Omarchy's language setting (4.5).
  readonly property bool norwegian: Quickshell.env("FOAMY_TEST_LANGUAGE") === "no"
  // launcher.py's run without bin/<arch>/ (a CPU with no bundled helper).
  readonly property bool nativeHelper: Quickshell.env("FOAMY_TEST_NATIVE") !== "0"
  // The run that also runs the fetch, command scope, guard and paste probes
  // (launcher.py runs them once: they depend on no theme, width or language).
  readonly property bool probes: Quickshell.env("FOAMY_TEST_PROBES") === "1"
  // The launch file's text when an SSH value was refused; it must not change.
  property string refusedLaunch: ""
  function said(english, norwegian) {
    return test.norwegian ? norwegian : english
  }
  function check(ok, detail) {
    if (!ok) {
      console.log("FOAMY FAIL " + detail)
      Qt.exit(1)
      return
    }
    checks++
    console.log("PASS " + detail)
  }
  // Holds the current stage until cond is true, or fails after 30 s: the
  // steps it waits for are child processes (a settings save through the
  // `omarchy` stand-in, a scope's helper run), which a loaded machine slows.
  property double waitingSince: 0
  function waitFor(cond) {
    if (cond) {
      waitingSince = 0
      return false
    }
    if (!waitingSince)
      waitingSince = Date.now()
    if (Date.now() - waitingSince > 30000) {
      check(false, "timed out waiting at stage " + (stage - 1))
      return true
    }
    stage--
    return true
  }
  // Types a query in the open view and runs the stage again, once the
  // search settles (backend.loading holds the timer until it does).
  property string asked: ""
  function ask(query) {
    test.asked = query
    view.setQuery(query)
    test.stage--
  }
  function select(id) {
    view.select(view.nthItem(1))
    for (var i = 0; i < 40 && view.selectedRow && view.selectedRow.itemId !== id; i++)
      view.move(1)
    check(view.selectedRow && view.selectedRow.itemId === id, "select " + id)
  }
  // The grid cell (AppCell) showing a row, found through the item tree.
  function findCell(index, item) {
    var node = item || view.cardItem
    if (node.coverStatus !== undefined && node.index === index && node.visible)
      return node
    for (var i = 0; i < node.children.length; i++) {
      var found = test.findCell(index, node.children[i])
      if (found)
        return found
    }
    return null
  }
  // The visible GridView (the Apps or scope grid).
  function findGrid(item) {
    var node = item || view.cardItem
    if (node.cellHeight !== undefined && node.visible)
      return node
    for (var i = 0; i < node.children.length; i++) {
      var found = test.findGrid(node.children[i])
      if (found)
        return found
    }
    return null
  }
  // Whether the header shows the scope tag (its text is the view title).
  function findTag(item) {
    var node = item || view.cardItem
    if (node.text === view.view.title && node.visible && node.font && node.font.weight === Font.DemiBold) {
      for (var p = node.parent; p; p = p.parent)
        if (!p.visible)
          return false
      return true
    }
    for (var i = 0; i < node.children.length; i++)
      if (test.findTag(node.children[i]))
        return true
    return false
  }
  // Every Text under the card: how many, whether one shows the markup query,
  // and the first that would render rich text (null when all are plain).
  function texts(item, found) {
    var node = item || view.cardItem
    var out = found || {
      count: 0,
      markup: false,
      rich: null
    }
    if (node.text !== undefined && node.textFormat !== undefined) {
      out.count++
      if (String(node.text).indexOf("<img") >= 0)
        out.markup = true
      if (node.textFormat !== Text.PlainText && !out.rich)
        out.rich = node
    }
    for (var i = 0; i < node.children.length; i++)
      test.texts(node.children[i], out)
    return out
  }
  function plainTexts(state) {
    var shown = test.texts()
    test.check(shown.count > 0 && shown.rich === null, "every text under the card is plain text (" + state + ")" + (shown.rich ? ": " + shown.rich.text : ""))
    return shown
  }
  // Whether a root search for the query lists the row.
  function listed(query, id) {
    return backend.callSync("rootSearch.search", {
      query: query,
      view: {
        kind: "root"
      }
    }).data.some(function (s) {
      return s.rows.some(function (r) {
        return r.id === id
      })
    })
  }
  function setting(key, action, value) {
    return backend.callSync("rootSearch.performAction", {
      id: "setting:" + key,
      action: action || "open",
      value: value,
      query: ""
    })
  }
  // The search field's clipped box (LauncherWindow queryBox).
  function findQueryBox(item) {
    var node = item || view.cardItem
    if (node.keepCursorVisible !== undefined)
      return node
    for (var i = 0; i < node.children.length; i++) {
      var found = test.findQueryBox(node.children[i])
      if (found)
        return found
    }
    return null
  }
  // The visible item under the card for which pick(node) is true.
  function findItem(pick, item) {
    var node = item || view.cardItem
    if (node.visible && pick(node))
      return node
    for (var i = 0; i < node.children.length; i++) {
      var found = test.findItem(pick, node.children[i])
      if (found)
        return found
    }
    return null
  }
  // How far the footer's left row (toast icon, text and its "Ctrl T" hint)
  // ends before the right row (the primary action and Actions) starts; below
  // zero when they overlap.
  function footerGap() {
    var copyHint = test.findItem(function (node) {
      return node.keys === "Ctrl T"
    })
    var actions = test.findItem(function (node) {
      return node.primary !== undefined && node.forceLayout !== undefined
    })
    if (!copyHint || !actions)
      return -1
    // A Row places its children when the window polishes; do it now.
    copyHint.parent.forceLayout()
    actions.forceLayout()
    return actions.mapToItem(view.cardItem, 0, 0).x - copyHint.mapToItem(view.cardItem, copyHint.width, 0).x
  }
  function type(text) {
    for (var i = 0; i < text.length; i++)
      view.handleKey({
        key: 0,
        modifiers: Qt.NoModifier,
        text: text.charAt(i)
      })
  }
  function key(code, modifiers) {
    view.handleKey({
      key: code,
      modifiers: modifiers || Qt.NoModifier,
      text: ""
    })
  }
  // A picture waits for the search field's caret to light up again: it
  // blinks (530 ms lit, 530 ms dark) from whenever it last moved, and a
  // grab in the dark half differs (no caret, and in a list view see-through
  // corners), as the root picture did once. A hidden caret (the action
  // panel is open) needs no wait. The harness runs without Hyprland, so
  // motion is on and the caret blinks.
  function capture(name, next) {
    var folder = Quickshell.env("FOAMY_MENU_SHOTS")
    if (!folder) {
      if (next)
        next()
      return
    }
    test.capturing = true
    var caret = test.findItem(function (node) {
      return node.atEnd !== undefined
    })
    var grab = function () {
      if (caret && caret.opacity !== 1)
        return
      if (caret)
        caret.opacityChanged.disconnect(grab)
      view.cardItem.grabToImage(function (result) {
        test.check(result.saveToFile(folder + "/" + name + ".png"), "save " + name)
        test.capturing = false
        if (next)
          next()
      })
    }
    if (caret)
      caret.opacityChanged.connect(grab)
    else
      grab()
  }
  Foamy.Menu {
    id: menu
    manifest: ({
        id: "foamy.menu",
        version: "0.0.0-runtime"
      })
  }
  FileView {
    id: browsed
    path: Quickshell.env("FOAMY_BROWSER_FILE")
    printErrors: false
    blockLoading: true
  }
  FileView {
    id: launched
    path: Quickshell.env("FOAMY_LAUNCH_FILE")
    printErrors: false
    blockLoading: true
  }
  FileView {
    id: copied
    path: Quickshell.env("FOAMY_COPY_FILE")
    printErrors: false
    blockLoading: true
  }
  // Paste through kit/clipboard.sh against the kit's wl-paste stand-in
  // (hostenv.clipboard_fakes in launcher.py): clipboardMode() sets what the
  // next paste reads, and the stage waits for it to be set.
  Process {
    id: clipboardFixture
    property bool done: false
    onExited: clipboardFixture.done = true
  }
  function clipboardMode(mode) {
    clipboardFixture.done = false
    clipboardFixture.command = ["clipboard-fixture", mode]
    clipboardFixture.running = true
  }
  function paste() {
    view.toast = null
    test.pasteStarted = Date.now()
    key(Qt.Key_V, Qt.ControlModifier)
  }
  property double pasteStarted: 0
  // The stand-in writes each paste's wl-paste pid here.
  FileView {
    id: pastePid
    path: Quickshell.env("TEST_CLIPBOARD_STATE") + ".pid"
    printErrors: false
    blockLoading: true
  }
  property string previousPid: ""
  // The launcher's settings.json, which stage 65 makes unusable for a
  // while: another program writes a new owner-only file over it.
  FileView {
    id: settingsFile
    path: test.backend ? test.backend.paths.db + "/settings.json" : ""
    printErrors: false
    blockLoading: true
  }
  property string savedSettings: ""
  Process {
    id: settingsWriter
  }
  function writeSettings(text) {
    settingsWriter.command = ["sh", "-c", 'umask 077; printf "%s" "$2" > "$1.new" && mv -- "$1.new" "$1"', "sh", settingsFile.path, text]
    settingsWriter.running = true
  }
  function settingsHealth() {
    return backend.callSync("system.healthDatabase", null).data.settings
  }
  function failureToast(english, norwegian) {
    return !!view.toast && view.toast.style === "failure" && view.toast.title === test.said(english, norwegian)
  }
  // The services' fetches against launcher.py's local HTTPS server.
  readonly property string fetchUrl: Quickshell.env("FOAMY_FETCH_URL")
  FoamyServices.CalculatorData {
    id: ratesProbe
    cacheDir: Quickshell.env("FOAMY_FETCH_CACHE")
    ratesEnabled: false
    property var said: []
    onMessage: function (level, text, metadata) {
      ratesProbe.said = ratesProbe.said.concat([text + (metadata && metadata.error ? ": " + metadata.error : "")])
    }
  }
  FileView {
    id: ratesCache
    path: Quickshell.env("FOAMY_FETCH_CACHE") + "/currencies.json"
    printErrors: false
    blockLoading: true
  }
  FoamyServices.ScopeSource {
    id: suggestProbe
    builtins: [Object.assign({}, Scopes.BUILTINS.filter(function (s) {
        return s.id === "duckduckgo"
      })[0], {
        suggest: true,
        suggestUrl: test.fetchUrl + "/ac?q={query}"
      })]
    property var stored: []
    onSuggestionsChanged: if (suggestions.duckduckgo)
      stored = stored.concat([suggestions.duckduckgo.query])
  }
  // Command scope runs, one at a time: a command that can't start, one that
  // hangs (ended at its deadline, its sh -c child too), two that flood their
  // output, in lines and without a newline (stopped at Scopes.MAX_OUTPUT
  // bytes, long before their 60 s deadline), then an ordinary one. Reading
  // the flood's 8 MB, a line at a time, took more than 10 s on a loaded
  // machine, so the default deadline ended it first. The hung
  // processes' pids go to FOAMY_SCOPE_PIDS; launcher.py checks none is left.
  readonly property string pidFile: Quickshell.env("FOAMY_SCOPE_PIDS")
  function commandScope(id, command, timeout) {
    return {
      id: id,
      title: id,
      keyword: id,
      source: {
        type: "command",
        command: command,
        timeout: timeout || 10000
      },
      open: ["true"]
    }
  }
  FoamyServices.ScopeSource {
    id: runProbe
    builtins: [test.commandScope("broken", ["/nonexistent/foamy-no-such-command"]), test.commandScope("hung", ["sh", "-c", 'sleep 300 & echo $! >> "$0"; echo $$ >> "$0"; sleep 300', test.pidFile], 2000), test.commandScope("flood", ["seq", "100000000"], 60000), test.commandScope("unbroken", ["sh", "-c", "yes | tr -d '\\n'"], 60000), test.commandScope("fine", ["printf", "one\\ntwo\\n"])]
    property var said: []
    onMessage: function (level, text, metadata) {
      runProbe.said = runProbe.said.concat([text])
    }
  }
  // A guard batch that hangs (its menu's one guard sleeps) ends at the
  // deadline, keeps the previous results and stops loading.
  FoamyServices.OmarchyMenuSource {
    id: guardProbe
    omarchyPath: Quickshell.env("FOAMY_GUARD_OMARCHY")
    commandTimeout: "2s"
    property var said: []
    onMessage: function (level, text, metadata) {
      guardProbe.said = guardProbe.said.concat([text])
    }
  }
  Timer {
    running: true
    repeat: true
    interval: 250
    onTriggered: {
      if (test.capturing)
        return
      // Each wait for the backend (its first load, and every scope or menu
      // reload a stage starts) gets 100 ticks (25 s). The count starts again
      // once it is ready: summed over the whole run, a loaded machine
      // passed 100 ticks without any single wait being long.
      if (!backend.ready || backend.loading) {
        if (++test.attempts > 100) {
          test.check(false, "backend becomes ready")
          Qt.exit(1)
        }
        return
      }
      test.attempts = 0
      switch (test.stage++) {
      case 0:
        test.check(backend.settings.currencyRates === false && backend.settings.webSearchHistory === false, "settings come from the foamy.menu entry in shell.json")
        test.check(menu.stockMenu.appLibrary !== null, "application library available without host facade")
        view.implicitWidth = Number(Quickshell.env("FOAMY_TEST_WIDTH"))
        view.implicitHeight = 800
        menu.open('{"menu":"root"}')
        break
      case 1:
        test.check(menu.opened && launcher.opened && !menu.stockMenu.opened, "root opens adopted launcher only")
        test.check(view.brandIcon === Quickshell.env("FOAMY_TEST_ICON"), "the header shows the icon set in shell.json")
        test.check(view.cardWidth <= view.width, "card fits viewport")
        test.check(view.visible && view.contentRevealed && view.contentItem.opacity === 1, "the overlay maps and reveals its content")
        test.check(view.placeholder === test.said("Search for apps and commands…", "Søk etter apper og kommandoer…"), "placeholder follows the language")
        test.check(backend.candidatesById["omarchy:apps"].title === test.said("Apps", "Apper"), "Omarchy menu labels use Omarchy's catalog")
        test.check(backend.candidatesById["builtin:calculator-history"].title === test.said("Calculator History", "Kalkulatorhistorikk"), "built-in titles are translated")
        test.check(backend.scopes.map(function (s) {
          return s.id
        }).join() === (test.nativeHelper ? "ssh,google,duckduckgo,steam,bookmarks,failing,long-failure,shelf" : "ssh,google,duckduckgo,bookmarks,failing,long-failure,shelf"), "built-in and user scopes load; enabled:false is skipped; Games once Steam lists games")
        test.check(backend.callSync("rootSearch.search", {
          query: "kettle",
          view: {
            kind: "root"
          }
        }).data.some(function (s) {
          return s.rows.some(function (r) {
            return r.id === "scope-item:shelf:Kettle"
          })
        }), "a list source's items survive the scope rebuild (rootSearch, requireItems)")
        test.capture("root", function () {
          view.setQuery("2 + 3 * 4")
        })
        break
      case 2:
        test.check(view.selectedRow && view.selectedRow.calcResult === "14", "calculator leads live search")
        var half = backend.calculate("1000.25 * 2")
        test.check(test.norwegian ? /^2\s000,5$/.test(half.result) : half.result === "2,000.5", "answers use the language's separators")
        test.check(half.plain === "2000.5", "the plain answer stays machine-readable")
        test.check(test.norwegian ? backend.calculate("2,5 * 2").result === "5" : backend.calculate("2,5 * 2") === null, "typed numbers follow the language's decimal mark")
        var dayFirst = backend.calculate("dager til 24.12.2030")
        test.check(test.norwegian ? !!dayFirst && dayFirst.result === backend.calculate("2030-12-24 - today").result : dayFirst === null, "24.12.2030 is a date only where the language writes the day first")
        test.check(test.norwegian ? backend.calculate("90 min to hours").result === "1,5 timer" : true, "unit names follow the language")
        test.capture("calculator", function () {
          key(Qt.Key_K, Qt.ControlModifier)
        })
        break
      case 3:
        test.check(view.actionPanelOpen, "Ctrl+K opens action panel")
        test.plainTexts("the action panel")
        test.capture("actions", function () {
          key(Qt.Key_Escape)
          test.check(!view.actionPanelOpen && menu.opened, "Escape closes panel without closing launcher")
          key(Qt.Key_Return)
        })
        break
      case 4:
        // The copy and the launches below are child processes: their files
        // show up when the child has run, which a loaded machine delays.
        copied.reload()
        if (test.waitFor(copied.text() === "14"))
          break
        test.check(copied.text() === "14", "Enter copies calculation through stdin")
        test.check(!menu.opened, "copy dismisses launcher")
        test.check(backend.callSync("calculator.historyGetAll", null).data.length === 1, "saves calculator history")
        menu.open('{"query":"1/0"}')
        break
      case 5:
        test.check(!view.selectedRow || !view.selectedRow.calcResult, "invalid calculation has no result")
        test.capture("invalid", function () {
          view.setQuery("<img src=\"https://example.invalid/test\">")
        })
        break
      case 6:
        var shown = test.plainTexts("a markup query")
        test.check(shown.markup, "the markup query shows as its text")
        test.check(!backend.callSync("rootSearch.performAction", {
          id: "missing",
          action: "open"
        }).ok, "unknown action reports failure")
        test.check(backend.callSync("system.info", null).data.version === "0.0.0-runtime", "system.info reports the manifest's version")
        test.capture("no-match", function () {
          menu.open('{"mode":"select","prompt":"Choose","options":["One","Two"],"width":280}')
        })
        break
      case 7:
        test.check(menu.stockMenu.opened && !launcher.opened, "selection routes to stock menu")
        test.check(menu.stockMenu.menuSurface.width === Style.space(280), "selection retains requested width")
        menu.open('{"mode":"input","prompt":"Name","width":310}')
        break
      case 8:
        test.check(menu.stockMenu.opened && menu.stockMenu.menuSurface.width === Style.space(310), "input routes to stock menu")
        menu.open('{"menu":"root"}')
        break
      case 9:
        test.check(!menu.stockMenu.opened && launcher.opened, "root restores launcher from stock dialog")
        view.request({
          id: "omarchy:apps",
          action: "open",
          query: ""
        })
        break
      case 10:
        test.check(view.gridView && launcher.opened && !menu.stockMenu.opened, "Apps opens the grid inside the launcher")
        test.check(view.selectedIndex === 0 && view.selectedRow && view.selectedRow.itemId.indexOf("app:") === 0, "grid selects the first app")
        test.check(view.gridColumns > 1, "grid lays apps out in columns")
        key(Qt.Key_Right)
        test.check(view.selectedIndex === 1, "Right moves one app")
        key(Qt.Key_Down)
        test.check(view.selectedIndex === 1 + view.gridColumns || (view.selectedIndex > 1 && view.nextSelectable(view.selectedIndex, 1) < 0), "Down moves a whole row")
        key(Qt.Key_Left)
        test.capture("apps", function () {
          view.setQuery("zzzz-no-such-app")
        })
        break
      case 11:
        test.check(view.gridView && view.selectedIndex === -1, "unmatched app search empties the grid")
        key(Qt.Key_Escape)
        test.check(view.gridView && view.query === "", "Escape clears the app search first")
        key(Qt.Key_Escape)
        test.check(view.atRoot && launcher.opened && !view.gridView, "Escape goes back from the grid to root")
        view.setQuery("ssh")
        key(Qt.Key_Tab)
        break
      case 12:
        // backend.loading holds the stage until the host list is read.
        test.check(view.view.kind === "scope" && view.view.scopeId === "ssh" && view.query === "", "Tab on the keyword enters the SSH scope")
        test.check(view.placeholder === test.said("Search hosts or type user@host…", "Søk eller skriv bruker@vert…"), "scope placeholder")
        if (!test.nativeHelper) {
          // The host list comes from the bundled helper too.
          var state = backend.scopeState("ssh")
          test.check(state.failure === "This plugin's helper isn't available for this CPU." && view.emptyText[1] === test.said(state.failure, "Hjelpeprogrammet til denne utvidelsen er ikke tilgjengelig for denne prosessoren."), "without a bundled helper the SSH scope says so in the user's language")
          view.popToRoot()
          view.setQuery("bookmarks")
          test.stage = 15
          break
        }
        test.check(view.selectedRow && view.selectedRow.itemId === "scope-item:ssh:db", "hosts listed A–Z; wildcards skipped")
        test.check(view.selectedRow.subtitle === "db.internal", "host shows its HostName")
        test.capture("ssh", function () {
          key(Qt.Key_Backspace)
          test.check(view.atRoot && view.query === "", "Backspace on an empty search removes the tag")
          view.setQuery("ssh we")
          key(Qt.Key_Tab)
        })
        break
      case 13:
        test.check(view.view.kind === "scope" && view.query === "we", "text after the keyword carries into the scope")
        test.check(view.selectedRow && view.selectedRow.title === "web", "the scope search narrows the hosts")
        test.check(backend.callSync("rootSearch.search", {
          query: "web",
          view: {
            kind: "root"
          }
        }).data.every(function (s) {
          return s.rows.every(function (r) {
            return r.kind !== "scope-item"
          })
        }), "hosts stay out of the root search")
        key(Qt.Key_Return)
        break
      case 14:
        // Then a destination that is not in ~/.ssh/config, typed in the
        // scope: offered as its own row, connected, and saved.
        if (test.asked === "ssh-typed") {
          test.asked = ""
          test.check(view.view.scopeId === "ssh" && view.selectedRow && view.selectedRow.itemId === "scope-query:ssh" && view.selectedRow.title === test.said("Connect “admin@new.example”", "Koble til «admin@new.example»"), "a typed destination is offered when no host matches")
          test.capture("ssh-typed", function () {
            key(Qt.Key_Return)
            test.asked = "ssh-typed-launched"
            test.stage--
          })
          break
        }
        if (test.asked === "ssh-typed-launched") {
          launched.reload()
          if (test.waitFor(/\nadmin@new\.example\n$/.test(launched.text())))
            break
          test.asked = ""
          var typedArgv = launched.text().trim().split("\n")
          test.check(/\/bin\/foamy-ssh-connect$/.test(typedArgv[1]) && typedArgv[2] === "admin@new.example", "Enter connects to the typed destination")
          // A destination the scope does not allow starts nothing; stage 18
          // checks the launch file again, after later launches had time.
          test.refusedLaunch = launched.text()
          var refused = backend.callSync("rootSearch.performAction", {
            id: "scope-query:ssh",
            action: "open",
            query: "-oProxyCommand=x"
          })
          test.check(refused.ok && refused.data.toast && refused.data.toast.style === "failure", "an SSH destination that starts with - is refused: " + JSON.stringify(refused))
          test.check(!!backend.callSync("frecency.get", {
            id: "scope-typed:ssh:admin@new.example"
          }).data, "the typed destination is saved")
          menu.open('{"menu":"root"}')
          view.popToRoot()
          view.setQuery("ssh")
          key(Qt.Key_Tab)
          var recent = backend.callSync("rootSearch.search", {
            query: "",
            view: view.view
          }).data
          test.check(recent[0].title === "Recent" && recent[0].rows.some(function (r) {
            return r.id === "scope-typed:ssh:admin@new.example"
          }), "saved destinations list under Recent")
          var cleared = backend.callSync("rootSearch.performAction", {
            id: "scope-typed:ssh:admin@new.example",
            action: "clear-history",
            confirmed: true,
            query: ""
          })
          test.check(cleared.ok && !backend.callSync("frecency.get", {
            id: "scope-typed:ssh:admin@new.example"
          }).data && !!backend.callSync("frecency.get", {
            id: "scope-item:ssh:web"
          }).data, "clearing the history keeps the hosts' ranking")
          view.popToRoot()
          view.setQuery("bookmarks")
          break
        }
        launched.reload()
        if (test.waitFor(/\nweb\n$/.test(launched.text())))
          break
        var argv = launched.text().trim().split("\n")
        test.check(argv[0] === "--app-id=TUI.tile" && /\/bin\/foamy-ssh-connect$/.test(argv[1]) && argv[2] === "web", "Enter connects through the terminal")
        test.check(!menu.opened, "connecting dismisses the launcher")
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("ssh admin@new.example")
        key(Qt.Key_Tab)
        test.asked = "ssh-typed"
        test.stage--
        break
      case 15:
        test.check(view.selectedRow && view.selectedRow.itemId === "scope:bookmarks", "a user scope is a row in the root search")
        key(Qt.Key_Tab)
        break
      case 16:
        // A scope's items match a misspelling through the helper, and a
        // plain prefix through the built-in matcher without one.
        var typo = test.nativeHelper ? "omrachy" : "omar"
        if (test.asked !== typo) {
          test.check(view.view.kind === "scope" && view.view.scopeId === "bookmarks" && view.selectedRow && view.selectedRow.title === "Omarchy", "Tab on a scope row enters it")
          test.ask(typo)
          break
        }
        test.asked = ""
        test.check(view.selectedRow && view.selectedRow.itemId === "scope-item:bookmarks:Omarchy", "the scope search finds “" + typo + "”")
        view.setQuery("")
        key(Qt.Key_Escape)
        test.check(view.atRoot, "Escape leaves the scope")
        view.setQuery("g rust & async")
        key(Qt.Key_Tab)
        break
      case 17:
        test.check(view.view.scopeId === "google" && view.query === "rust & async", "g + Tab enters Google with the search")
        test.check(view.selectedRow && view.selectedRow.itemId === "scope-query:google", "the typed text is the first row")
        test.check(backend.callSync("rootSearch.search", {
          query: view.query,
          view: view.view
        }).data.length === 1, "no saved searches or suggestions unless turned on")
        key(Qt.Key_Return)
        break
      case 18:
        browsed.reload()
        if (test.waitFor(browsed.text().indexOf("rust%20%26%20async") >= 0))
          break
        test.check(browsed.text().trim() === "https://www.google.com/search?q=rust%20%26%20async", "Enter opens the encoded search URL")
        if (test.nativeHelper) {
          launched.reload()
          test.check(launched.text() === test.refusedLaunch, "the refused SSH destination started nothing")
        }
        test.check(!backend.callSync("frecency.get", {
          id: "scope-item:google:rust & async"
        }).data, "searches are not saved without history")
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("ddg pasta")
        key(Qt.Key_Tab)
        key(Qt.Key_Return)
        break
      case 19:
        test.check(!!backend.callSync("frecency.get", {
          id: "scope-item:duckduckgo:pasta"
        }).data, "history: true saves the search")
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("ddg")
        key(Qt.Key_Tab)
        var saved = backend.callSync("rootSearch.search", {
          query: "",
          view: view.view
        }).data
        test.check(view.view.scopeId === "duckduckgo" && view.query === "", "ddg + Tab enters DuckDuckGo")
        test.check(saved.length === 2 && saved[1].title === "Recent Searches" && saved[1].rows[0].value === "pasta", "saved searches list under Recent Searches")
        test.capture("ddg", function () {
          key(Qt.Key_Escape)
          view.setQuery("zzzz no match")
        })
        break
      case 20:
        for (var step = 0; step < 20 && view.selectedRow && view.selectedRow.itemId !== "scope-query:google"; step++)
          view.move(1)
        test.check(view.selectedRow && view.selectedRow.itemId === "scope-query:google", "web searches are offered for any text")
        key(Qt.Key_Tab)
        test.check(view.view.scopeId === "google" && view.query === "zzzz no match", "Tab on Search Google enters it with the text")
        key(Qt.Key_Escape)
        key(Qt.Key_Escape)
        key(Qt.Key_Comma, Qt.ControlModifier)
        break
      case 21:
        test.check(view.view.kind === "settings", "Ctrl+, opens the settings")
        test.check(view.selectedRow && view.selectedRow.itemId === "setting:windowMode", "settings start with the window section")
        test.check(view.placeholder === test.said("Search settings…", "Søk i innstillinger…"), "settings placeholder")
        test.capture("settings", function () {
          test.select("setting:webSearchHistory")
          test.check(view.selectedRow.title === test.said("Save web searches", "Lagre nettsøk"), "setting titles are translated")
          key(Qt.Key_Return)
          test.check(backend.settings.webSearchHistory === true, "Enter toggles a switch at once")
          test.select("setting:clockFormat")
          key(Qt.Key_Right)
          test.check(backend.settings.clockFormat === "12h", "→ picks the next choice")
          test.select("setting:width")
          key(Qt.Key_Return)
          test.check(view.view.kind === "setting-edit" && view.query === "360", "Enter on a number edits it")
          view.setQuery("wide")
          key(Qt.Key_Return)
          test.check(view.view.kind === "setting-edit" && view.toast && view.toast.style === "failure", "an invalid value is refused")
          view.setQuery("1200")
          key(Qt.Key_Return)
          test.check(view.view.kind === "settings" && backend.settings.width === 1200, "a valid value saves and goes back")
        })
        break
      case 22:
        // The saves reach shell.json (through `omarchy bar set` here) and come back.
        if (test.waitFor(backend.settingsEntry.width === 1200 && backend.settingsEntry.clockFormat === "12h" && backend.settingsEntry.webSearchHistory === true))
          break
        // Settings rows match a misspelling through the helper, and a plain
        // prefix through the built-in matcher without one.
        var misspelt = test.nativeHelper ? "stricntess" : "strictnes"
        if (test.asked !== misspelt) {
          test.ask(misspelt)
          break
        }
        test.asked = ""
        test.check(view.selectedRow && view.selectedRow.itemId === "setting:rootSearchSensitivity", "the settings search finds “" + misspelt + "”")
        view.setQuery("")
        test.check(menu.stockMenu.configuredWidth === 1200, "the bar entry in shell.json holds the settings")
        test.select("setting:width")
        test.check(view.selectedRow.typeLabel === "1200 px", "the row shows the saved value")
        // The refusal toast of a setting value, with its long hint, next to
        // the row's primary action and Actions.
        view.showToast("failure", test.said("A whole number from 0 to 4096. Empty uses the default.", "Et heltall fra 0 til 4096. Tomt bruker standardverdien."))
        var footerGap = test.footerGap()
        test.check(footerGap >= 0, "a long failure toast and its Ctrl T end before the footer's actions (gap " + footerGap + " px)")
        key(Qt.Key_K, Qt.ControlModifier)
        test.check(view.actionPanelOpen && view.actions.some(function (a) {
          return a.id === "reset-setting"
        }), "a changed setting offers Reset to Default")
        key(Qt.Key_Escape)
        key(Qt.Key_Escape)
        launcher.run("builtin:omarchy-menu")
        break
      case 23:
        // Menu.qml opens the stock menu on a later event loop turn
        // (Qt.callLater), and a loaded machine can run this tick first.
        if (test.waitFor(menu.stockMenu.opened))
          break
        test.check(menu.stockMenu.opened && !launcher.opened, "original-menu action survives launcher close")
        menu.open('{"menu":"system"}')
        break
      case 24:
        test.check(menu.stockMenu.opened && !launcher.opened, "named stock routes remain supported")
        if (!test.probes) {
          test.stage = 29
          break
        }
        ratesProbe.ratesUrl = test.fetchUrl + "/endless"
        ratesProbe.fetchRates()
        break
      case 25:
        if (test.waitFor(!ratesProbe.fetching && ratesProbe.said.length > 0))
          break
        test.check(ratesProbe.rates === null && ratesProbe.said[ratesProbe.said.length - 1] === "could not fetch exchange rates: reply is over " + Fetch.MAX_BYTES + " bytes", "an endless rates reply stops at the cap and fails: " + ratesProbe.said)
        ratesProbe.ratesUrl = test.fetchUrl + "/v1/latest"
        ratesProbe.fetchRates()
        break
      case 26:
        if (test.waitFor(!ratesProbe.fetching && ratesProbe.said.length > 1))
          break
        test.check(ratesProbe.rates && ratesProbe.rates.base === "EUR" && ratesProbe.rates.rates.USD === 1.08 && ratesProbe.said[1] === "exchange rates updated", "a normal rates reply still parses: " + ratesProbe.said)
        ratesCache.reload()
        test.check(JSON.parse(ratesCache.text()).rates.NOK === 11.7, "fetched rates are cached")
        suggestProbe.suggest("duckduckgo", "huge pasta")
        break
      case 27:
        var huge = suggestProbe.suggestions.duckduckgo
        if (test.waitFor(huge && huge.query === "huge pasta"))
          break
        test.check(huge.items.length === 0, "an endless suggestion reply stops at the cap and lists nothing")
        suggestProbe.suggest("duckduckgo", "slow pasta")
        break
      case 28:
        // "slow pasta" is in flight (2 s); the next text replaces it.
        suggestProbe.suggest("duckduckgo", "pasta")
        break
      case 29:
        if (test.probes) {
          var normal = suggestProbe.suggestions.duckduckgo
          if (test.waitFor(normal && normal.query === "pasta"))
            break
          test.check(normal.items.join() === "pasta one,pasta two", "a normal suggestion reply still parses")
          test.check(suggestProbe.stored.join() === "huge pasta,pasta", "a replaced request's reply is dropped: " + suggestProbe.stored)
        }
        menu.open('{"menu":"root"}')
        view.popToRoot()
        // The search field edits at its cursor.
        view.setQuery("gmes")
        test.check(view.cursorPos === 4, "the cursor follows a query set from outside to its end")
        for (var l = 0; l < 3; l++)
          key(Qt.Key_Left)
        test.type("a")
        test.check(view.query === "games" && view.cursorPos === 2, "← moves the cursor and typing inserts there: " + view.query + " " + view.cursorPos)
        key(Qt.Key_Home)
        key(Qt.Key_Delete)
        test.check(view.query === "ames" && view.cursorPos === 0, "Home, then Delete removes the first character")
        test.type("g")
        key(Qt.Key_End)
        test.check(view.query === "games" && view.cursorPos === 5, "End moves to the end")
        key(Qt.Key_Left, Qt.ControlModifier)
        test.check(view.cursorPos === 0, "Ctrl+← jumps a word")
        key(Qt.Key_Backspace)
        test.check(view.query === "games", "Backspace at the start removes nothing")
        // A query wider than the field scrolls to keep the cursor in view.
        view.setQuery("convert " + "1234567890 ".repeat(30) + "usd to nok")
        var box = test.findQueryBox()
        test.check(box && box.scroll > 0 && box.offsetOf(view.query) <= box.width + 1, "a long query shows its end, where the cursor is")
        key(Qt.Key_Home)
        test.check(box.scroll === 0, "Home scrolls back to the start")
        key(Qt.Key_End)
        test.check(box.scroll > 0, "End scrolls to the end again")
        view.setQuery("games")
        break
      case 30:
        if (test.waitFor(!view.searchPending))
          break
        if (!test.nativeHelper) {
          test.check(!view.selectedRow || view.selectedRow.itemId !== "scope:steam", "no Games row without Steam games")
          view.setQuery("steam")
          key(Qt.Key_Tab)
          test.check(view.atRoot, "and no steam keyword either")
          test.stage = 35
          break
        }
        if (test.waitFor(view.selectedRow && view.selectedRow.itemId === "scope:steam"))
          break
        test.check(view.selectedRow.title === test.said("Games", "Spill"), "Games is a root row")
        test.check(view.selectedRow.typeLabel === test.said("Menu", "Meny") && view.actionsForSelected()[0].title === "Run", "Games reads and runs like Apps")
        test.check(!backend.callSync("rootSearch.search", {
          query: "deep rock",
          view: {
            kind: "root"
          }
        }).data.some(function (s) {
          return s.rows.some(function (r) {
            return r.kind === "scope-item"
          })
        }), "games stay out of the root search until the switch is on")
        backend.callSync("rootSearch.performAction", {
          id: "setting:steamGames",
          action: "open"
        })
        break
      case 31:
        if (test.waitFor(backend.scopes.some(function (s) {
          return s.id === "steam" && s.rootSearch
        })))
          break
        view.setQuery("deep rock")
        break
      case 32:
        if (test.waitFor(!view.searchPending && view.selectedRow && view.selectedRow.itemId === "scope-item:steam:548430"))
          break
        test.check(view.selectedRow.subtitle === "Steam" && view.selectedRow.typeLabel === test.said("Game", "Spill"), "with the switch on, games are found from the root search, like apps")
        test.capture("games-root", function () {
          view.setQuery("steam")
          key(Qt.Key_Tab)
        })
        break
      case 33:
        test.check(view.view.kind === "scope" && view.view.scopeId === "steam", "steam + Tab enters Games")
        test.check(view.gridView && view.coverGrid, "Games is a grid of covers")
        test.check(!test.findTag(), "a grid scope shows no tag, as Apps doesn't")
        test.check(view.placeholder === test.said("Search games…", "Søk etter spill…"), "Games placeholder")
        if (test.waitFor(view.selectedRow && view.selectedRow.title === "Deep Rock Galactic"))
          break
        test.check(/\/library_600x900\.jpg$/.test(view.selectedRow.cover) && /\.jpg$/.test(view.selectedRow.image), "a game carries its cover and icon")
        var cell = test.findCell(view.selectedIndex)
        if (test.waitFor(cell && cell.coverStatus === Image.Ready))
          break
        test.check(cell.covers && cell.hasCover, "the cover art shows in the grid")
        test.plainTexts("the cover grid")
        test.check(view.nthItem(2) >= 0 && test.findCell(view.nthItem(2)) && !test.findCell(view.nthItem(2)).hasCover, "a game without a cover shows its icon on a tile")
        var flick = test.findGrid()
        flick.contentY = 40
        view.select(view.nthItem(1), true)
        test.check(flick.contentY === 40, "selecting under the pointer does not scroll the grid")
        view.select(view.nthItem(1))
        test.check(flick.contentY === 0, "keyboard selection still scrolls into view")
        test.capture("steam", function () {
          key(Qt.Key_Return)
        })
        break
      case 34:
        launched.reload()
        if (test.waitFor(launched.text().indexOf("steam://") >= 0))
          break
        test.check(launched.text().trim().split("\n").join(" ") === "-- xdg-open steam://rungameid/548430", "Enter plays the game through steam://: " + launched.text())
        test.check(!menu.opened, "playing dismisses the launcher")
        break
      case 35:
        if (!test.probes) {
          test.stage = 52
          break
        }
        runProbe.refresh("broken")
        runProbe.refresh("hung")
        runProbe.refresh("flood")
        runProbe.refresh("unbroken")
        runProbe.refresh("fine")
        test.check(runProbe.loading, "command scopes queue up")
        break
      case 36:
        if (test.waitFor(!runProbe.loading && !guardProbe.loading && guardProbe.said.length > 0))
          break
        test.check(/^\/nonexistent\/foamy-no-such-command: /.test((runProbe.failures.broken || [""])[0]) && !runProbe.items.broken, "a command that can't run fails its scope: " + JSON.stringify(runProbe.failures.broken))
        test.check(JSON.stringify(runProbe.failures.hung) === JSON.stringify(["timed out", []]) && !runProbe.items.hung, "a hung command scope times out at its deadline: " + JSON.stringify(runProbe.failures.hung))
        test.check(!runProbe.failures.flood && runProbe.items.flood.length === Scopes.MAX_ITEMS && runProbe.items.flood[0].title === "1" && runProbe.said.some(function (t) {
          return t.indexOf("scope flood: output is over") === 0
        }), "a flood of output is stopped at the cap and its first items kept")
        test.check(!runProbe.failures.unbroken && runProbe.items.unbroken.length === 0 && runProbe.said.some(function (t) {
          return t.indexOf("scope unbroken: output is over " + Scopes.MAX_OUTPUT + " bytes") === 0
        }), "output without a newline stops at the cap, not at its 60 s deadline")
        test.check(!runProbe.failures.fine && runProbe.items.fine.map(function (i) {
          return i.title
        }).join() === "one,two", "the queue goes on after them")
        test.check(guardProbe.said.indexOf("Menu guard refresh failed; keeping previous results.") >= 0 && Object.keys(guardProbe.guards.when).length === 0, "a hung guard batch ends and keeps the previous results: " + guardProbe.said)
        break
      case 37:
        menu.open('{"menu":"root"}')
        view.popToRoot()
        test.clipboardMode("unicode")
        break
      case 38:
        if (test.waitFor(clipboardFixture.done && launcher.opened))
          break
        test.paste()
        test.check(view.query === "", "paste waits for the bounded read")
        break
      case 39:
        if (test.waitFor(view.query !== ""))
          break
        test.check(view.query === "/home/test/Blåbær 📁" && view.cursorPos === view.query.length, "Ctrl+V pastes the clipboard's text through kit/clipboard.sh: " + view.query)
        view.setQuery("")
        test.clipboardMode("stream")
        break
      case 40:
        if (test.waitFor(clipboardFixture.done))
          break
        test.paste()
        break
      case 41:
        if (test.waitFor(!!view.toast))
          break
        test.check(test.failureToast("Clipboard text is too large or contains invalid characters.", "Teksten på utklippstavlen er for stor eller inneholder ugyldige tegn.") && view.query === "", "an endless clipboard is refused at the byte cap, with a toast: " + JSON.stringify(view.toast))
        test.clipboardMode("failure")
        break
      case 42:
        if (test.waitFor(clipboardFixture.done))
          break
        test.paste()
        break
      case 43:
        if (test.waitFor(!!view.toast))
          break
        test.check(test.failureToast("Could not paste clipboard text. Copy plain text and try again.", "Kunne ikke lime inn fra utklippstavlen. Kopier ren tekst og prøv igjen.") && view.query === "", "a clipboard read that fails shows a toast: " + JSON.stringify(view.toast))
        test.clipboardMode("delayed")
        break
      case 44:
        if (test.waitFor(clipboardFixture.done))
          break
        // Type and delete a character before the delayed read answers: the
        // query is back as it was, but the paste is still stale.
        test.paste()
        test.check(view.pasteRevision >= 0, "the delayed paste started")
        test.type("x")
        key(Qt.Key_Backspace)
        break
      case 45:
        // The window resets pasteRevision once the result was used or dropped.
        if (test.waitFor(view.pasteRevision === -1))
          break
        test.check(view.query === "" && !view.toast, "a paste that answers after typing (even typing undone) is dropped: " + view.query)
        view.setQuery("")
        test.clipboardMode("stall")
        break
      case 46:
        if (test.waitFor(clipboardFixture.done))
          break
        test.paste()
        break
      case 47:
        if (test.waitFor(!!view.toast))
          break
        var waited = Date.now() - test.pasteStarted
        test.check(test.failureToast("Clipboard paste timed out. Copy the text again.", "Innliming fra utklippstavlen tok for lang tid. Kopier teksten på nytt.") && waited < 5000 && view.query === "", "a stalled clipboard ends at the 2 s deadline, with a toast, after " + waited + " ms")
        test.clipboardMode("ignore")
        break
      case 48:
        if (test.waitFor(clipboardFixture.done))
          break
        pastePid.reload()
        test.previousPid = pastePid.text()
        test.paste()
        break
      case 49:
        pastePid.reload()
        if (test.waitFor(pastePid.text() !== test.previousPid))
          break
        // launcher.py checks that this paste's wl-paste (which ignores
        // TERM) is gone at the end.
        console.log("FOAMY PASTE PID " + pastePid.text())
        test.clipboardMode("normal")
        break
      case 50:
        if (test.waitFor(clipboardFixture.done))
          break
        // Closing mid-read stops it. Reopening and pasting at once, while
        // the stopped read is still ending, must neither start a second
        // read nor take the stopped one's exit as its own failure.
        menu.close()
        test.check(!menu.opened && view.pasteRevision === -1, "closing the launcher cancels its paste")
        menu.open('{"menu":"root"}')
        test.paste()
        break
      case 51:
        // A paste with the filter list (Ctrl+P) open goes into its filter,
        // as typing does, not into the search field behind it.
        if (test.asked === "filter-paste") {
          var filterList = test.findItem(function (node) {
            return node.visibleActions !== undefined && node.placeholder === test.said("Filter…", "Filtrer…")
          })
          // As below: press again until a read starts.
          if (view.pasteRevision === -1 && view.query === "" && filterList && filterList.filter === "")
            key(Qt.Key_V, Qt.ControlModifier)
          if (test.waitFor(view.query !== "" || (!!filterList && filterList.filter !== "")))
            break
          test.asked = ""
          test.check(!!filterList && filterList.filter === "folder" && view.query === "", "a paste with the filter list open goes into its filter: filter " + (filterList ? JSON.stringify(filterList.filter) : "not shown") + ", query " + JSON.stringify(view.query))
          key(Qt.Key_Escape)
          break
        }
        // While the stopped read is still ending the reader refuses a new
        // one and Ctrl+V does nothing; press again until a read starts.
        // Without that refusal the paste above ends with the stopped read's
        // failure.
        if (view.toast) {
          test.check(false, "a paste after a cancelled one got the stopped read's failure: " + JSON.stringify(view.toast))
          break
        }
        if (view.query === "" && view.pasteRevision === -1)
          key(Qt.Key_V, Qt.ControlModifier)
        if (test.waitFor(view.query !== ""))
          break
        test.check(view.query === "folder" && !view.toast, "the next paste works: " + view.query)
        view.setQuery("")
        key(Qt.Key_P, Qt.ControlModifier)
        test.paste()
        test.asked = "filter-paste"
        test.stage--
        break
      case 52:
        // Every run comes here, in different states. First a command scope
        // that fails without stderr: its empty view says how it exited, in
        // the user's language.
        if (test.asked === "") {
          menu.open('{"menu":"root"}')
          view.popToRoot()
          view.setQuery("fail")
          key(Qt.Key_Tab)
          test.asked = "failing-scope"
          test.stage--
          break
        }
        if (test.asked === "failing-scope") {
          if (test.waitFor(view.view.kind === "scope" && !!view.scopeState && view.scopeState.failure !== ""))
            break
          test.check(JSON.stringify(view.emptyText) === JSON.stringify([test.said("Could not load Failing", "Kunne ikke laste Failing"), test.said("exited with code 3", "avsluttet med kode 3")]), "a command scope that fails says how it exited, in the user's language: " + JSON.stringify(view.emptyText))
          // Then one whose reason is wider than the card.
          view.popToRoot()
          view.setQuery("longfail")
          key(Qt.Key_Tab)
          test.asked = "long-failure"
          test.stage--
          break
        }
        if (test.asked === "long-failure") {
          if (test.waitFor(view.view.scopeId === "long-failure" && !!view.scopeState && view.scopeState.failure !== ""))
            break
          test.asked = ""
          var reason = test.findItem(function (node) {
            return node.text === view.emptyText[1]
          })
          var at = reason ? reason.mapToItem(view.cardItem, 0, 0) : null
          test.check(!!at && view.emptyText[1].indexOf("long-failure: ") === 0 && reason.lineCount > 1 && at.x >= 0 && at.x + reason.width <= view.cardItem.width, "a failure's long reason wraps inside the card: " + JSON.stringify(at) + " " + (reason ? reason.width + " of " + view.cardItem.width : "not shown"))
        }
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("")
        view.request({
          id: "builtin:calculator-history",
          action: "open",
          query: ""
        })
        break
      case 53:
        // A destructive action asks first: Esc keeps the history, Enter on
        // the alert clears it.
        var history = function () {
          return backend.callSync("calculator.historyGetAll", null).data.length
        }
        if (test.waitFor(view.view.kind === "calculator-history" && !!view.selectedRow))
          break
        var kept = history()
        test.check(kept > 0, "Calculator History lists the saved calculation")
        key(Qt.Key_D, Qt.ControlModifier | Qt.ShiftModifier)
        test.check(!!view.alert && history() === kept, "Ctrl+Shift+D asks before it deletes the history")
        test.plainTexts("the alert")
        key(Qt.Key_Escape)
        test.check(!view.alert && history() === kept && launcher.opened, "Esc on the alert keeps the history")
        key(Qt.Key_D, Qt.ControlModifier | Qt.ShiftModifier)
        key(Qt.Key_Return)
        test.check(!view.alert && history() === 0 && !!view.toast && view.toast.title === test.said("History cleared", "Historikk tømt"), "Enter on the alert clears the history")
        // A power command asks too; launcher.py fails the run if anything
        // reached omarchy-system.
        var shutdown = backend.callSync("rootSearch.performAction", {
          id: "omarchy:system.shutdown",
          action: "open",
          query: ""
        })
        test.check(shutdown.ok && !!shutdown.data.confirm && shutdown.data.confirm.destructive === true && shutdown.data.confirm.primary === "Shut Down", "Shut Down asks first: " + JSON.stringify(shutdown))
        // Aliases, through the handler only Backend.qml has.
        var alias = function (id, value) {
          return backend.callSync("settings.updateCommandSettings", {
            commandId: id,
            alias: value
          })
        }
        var saved = alias("builtin:settings", " ST ")
        test.check(saved.ok && backend.callSync("settings.getCommandSettings", {
          commandId: "builtin:settings"
        }).data.alias === "st", "an alias is saved trimmed and in lower case")
        var taken = alias("builtin:calculator-history", "st")
        var owner = backend.candidatesById["builtin:settings"].title
        test.check(!taken.ok && taken.error === test.said("Alias “st” is already used by " + owner, "Aliaset «st» brukes allerede av " + owner), "an alias another command uses is refused, in the user's language: " + taken.error)
        // AltGr+Space types U+00A0 on the Norwegian layout; the alias view's
        // Space key lets it through.
        var spaced = alias("builtin:calculator-history", "a b")
        test.check(!spaced.ok && spaced.error === test.said("An alias cannot contain spaces", "Et alias kan ikke inneholde mellomrom"), "an alias with a space is refused, in the user's language: " + spaced.error)
        var unknown = alias("builtin:no-such-command", "x")
        test.check(!unknown.ok && unknown.error.indexOf("Unknown command") >= 0, "an alias for an unknown command is refused: " + unknown.error)
        view.popToRoot()
        view.setQuery("st")
        break
      case 54:
        if (test.waitFor(!view.searchPending))
          break
        test.check(view.selectedRow && view.selectedRow.itemId === "builtin:settings", "the alias selects its command")
        var removed = backend.callSync("settings.updateCommandSettings", {
          commandId: "builtin:settings",
          alias: ""
        })
        test.check(removed.ok && JSON.stringify(backend.callSync("settings.getCommandSettings", {
          commandId: "builtin:settings"
        }).data) === "{}", "an empty alias removes it")
        view.setQuery(test.said("calculator history", "kalkulatorhistorikk"))
        break
      case 55:
        if (test.waitFor(!view.searchPending))
          break
        var query = test.said("calculator history", "kalkulatorhistorikk")
        test.check(view.selectedRow && view.selectedRow.itemId === "builtin:calculator-history", "select Calculator History")
        key(Qt.Key_D, Qt.AltModifier | Qt.ShiftModifier)
        test.check(!!view.toast && (view.toast.actions || []).some(function (a) {
          return a.id === "undo"
        }) && !test.listed(query, "builtin:calculator-history"), "Alt+Shift+D disables a command and offers Undo")
        view.runToastAction("undo")
        test.check(test.listed(query, "builtin:calculator-history"), "Undo enables it again")
        // Only the zoom is the launcher's own setting; the rest is shell.json's.
        var zoom = backend.callSync("settings.updateGeneralSettings", {
          uiZoom: 1.2
        })
        test.check(zoom.ok && Math.abs(view.zoom - 1.2) < 1e-9, "a zoom saved through the backend scales the window: " + view.zoom)
        backend.callSync("settings.updateGeneralSettings", {
          uiZoom: 1
        })
        var shellKey = backend.callSync("settings.updateGeneralSettings", {
          windowMode: "compact"
        })
        test.check(!shellKey.ok && shellKey.error.indexOf("omarchy bar set foamy.menu windowMode") >= 0, "a shell.json setting is refused with the command that sets it: " + shellKey.error)
        var bigZoom = backend.callSync("settings.updateGeneralSettings", {
          uiZoom: "big"
        })
        test.check(!bigZoom.ok && bigZoom.error.indexOf("uiZoom must be a number") >= 0, "a zoom that is not a number is refused: " + bigZoom.error)
        // The reason, not just a failure: a broken handler fails too.
        var off = backend.callSync("calculator.refreshCurrencies", null)
        test.check(!off.ok && off.error.indexOf("currencyRates is off") >= 0, "rates are not downloaded while currencyRates is off: " + off.error)
        // The window settings no other stage acts on; each is set back after.
        test.setting("navigationBindings")
        break
      case 56:
        if (test.waitFor(backend.settings.navigationBindings === "vim-motions"))
          break
        view.popToRoot()
        view.setQuery("a")
        break
      case 57:
        if (test.waitFor(!view.searchPending))
          break
        var first = view.selectedIndex
        key(Qt.Key_N, Qt.ControlModifier)
        test.check(view.selectedIndex === first, "with Ctrl+J/K, Ctrl+N does not move")
        key(Qt.Key_J, Qt.ControlModifier)
        test.check(first >= 0 && view.selectedIndex === view.nextSelectable(first, 1), "with Ctrl+J/K, Ctrl+J moves one row down")
        view.setQuery("")
        test.setting("navigationBindings")
        break
      case 58:
        if (test.waitFor(backend.settings.navigationBindings === "emacs"))
          break
        test.setting("windowMode")
        break
      case 59:
        // A paste that fails at the empty compact root: its toast shows, in
        // the card, and the card is compact again once the toast is gone.
        if (test.asked === "compact-clipboard") {
          if (test.waitFor(clipboardFixture.done))
            break
          test.paste()
          test.asked = "compact-paste"
          test.stage--
          break
        }
        if (test.asked === "compact-paste") {
          if (test.waitFor(!!view.toast))
            break
          test.asked = ""
          var toastText = test.findItem(function (node) {
            return node.text === view.toast.title && node.elide !== undefined
          })
          test.check(test.failureToast("Could not paste clipboard text. Copy plain text and try again.", "Kunne ikke lime inn fra utklippstavlen. Kopier ren tekst og prøv igjen.") && !view.compact && !!toastText && toastText.mapToItem(view.cardItem, 0, toastText.height).y <= view.cardItem.height, "a paste that fails at the empty compact root shows its toast: compact " + view.compact + ", toast text " + (toastText ? "shown" : "not shown"))
          view.toast = null
          test.check(view.compact, "the window is compact again once the toast is gone")
          test.setting("windowMode")
          break
        }
        if (test.waitFor(backend.settings.windowMode === "compact"))
          break
        view.popToRoot()
        view.setQuery("")
        // A toast from an earlier stage would show the whole card.
        view.toast = null
        test.check(view.compact, "compact mode shows only the search field at root")
        view.setQuery("f")
        test.check(!view.compact, "typing expands the compact window")
        view.setQuery("")
        test.clipboardMode("failure")
        test.asked = "compact-clipboard"
        test.stage--
        break
      case 60:
        if (test.waitFor(backend.settings.windowMode === "expanded"))
          break
        test.setting("escapeKeyBehavior")
        break
      case 61:
        if (test.waitFor(backend.settings.escapeKeyBehavior === "close-and-pop-to-root"))
          break
        key(Qt.Key_Comma, Qt.ControlModifier)
        test.check(view.view.kind === "settings", "Ctrl+, opens the settings")
        key(Qt.Key_Escape)
        test.check(!menu.opened && view.atRoot, "Esc closes the launcher and starts over")
        menu.open('{"menu":"root"}')
        test.setting("escapeKeyBehavior")
        break
      case 62:
        if (test.waitFor(backend.settings.escapeKeyBehavior === "pop-back-or-close"))
          break
        test.setting("popToRootTimeout", "set", "0")
        break
      case 63:
        if (test.waitFor(backend.settings.popToRootTimeout === 0))
          break
        view.request({
          id: "builtin:calculator-history",
          action: "open",
          query: ""
        })
        test.check(!view.atRoot, "Calculator History opens")
        menu.close()
        test.check(view.atRoot, "with 0 seconds, closing starts over at once")
        menu.open('{"menu":"root"}')
        test.setting("popToRootTimeout", "set", "90")
        break
      case 64:
        if (test.waitFor(backend.settings.popToRootTimeout === 90))
          break
        // The IPC handler that `omarchy-shell foamy-menu …` and keybindings call.
        var ipc = null
        for (var d = 0; d < launcher.data.length; d++)
          if (launcher.data[d] && launcher.data[d].target === "foamy-menu")
            ipc = launcher.data[d]
        test.check(!!ipc, "the IPC handler is there")
        if (!ipc)
          break
        test.check(ipc.ping() === "ok", "IPC ping answers ok")
        test.check(ipc.hide() === "hidden" && !menu.opened && ipc.isOpen() === "false", "IPC hide closes the launcher")
        test.check(ipc.show() === "shown" && menu.opened && ipc.isOpen() === "true", "IPC show opens it")
        test.check(ipc.toggle() === "hidden" && !menu.opened && ipc.toggle() === "shown" && menu.opened, "IPC toggle closes and opens it")
        var info = JSON.parse(ipc.call("system.info", ""))
        test.check(info.ok && info.data.version === "0.0.0-runtime", "IPC call reaches the backend")
        var notJson = JSON.parse(ipc.call("system.info", "{oops"))
        test.check(!notJson.ok && notJson.error.indexOf("data is not JSON") === 0, "IPC call refuses data that is not JSON: " + notJson.error)
        ipc.run("builtin:settings")
        test.check(menu.opened && view.view.kind === "settings", "IPC run opens a command")
        break
      case 65:
        // The zoom keys on a settings.json the launcher cannot use: the zoom
        // stays and a failure toast says why, in the user's language. Then
        // the file is put back and the store takes changes again.
        if (test.asked === "") {
          settingsFile.reload()
          test.savedSettings = settingsFile.text()
          test.check(test.savedSettings.indexOf("schemaVersion") >= 0, "settings.json is read before it is replaced")
          test.writeSettings("[]")
          test.asked = "settings-unusable"
          test.stage--
          break
        }
        if (test.asked === "settings-unusable") {
          if (test.waitFor(test.settingsHealth().readOnly))
            break
          var zoomBefore = view.zoom
          view.toast = null
          key(Qt.Key_Plus, Qt.ControlModifier)
          test.check(view.zoom === zoomBefore && test.failureToast("settings.json is read-only: document is not a JSON object", "settings.json er skrivebeskyttet: dokumentet er ikke et JSON-objekt"), "a zoom key on an unusable settings.json keeps the zoom and says why: " + JSON.stringify(view.toast))
          test.writeSettings(test.savedSettings)
          test.asked = "settings-back"
          test.stage--
          break
        }
        if (test.waitFor(!test.settingsHealth().readOnly))
          break
        test.asked = ""
        break
      case 66:
        menu.close()
        test.check(!menu.opened, "close dismisses either view")
        var rejected = false
        try {
          menu.open("[]")
        } catch (e) {
          rejected = true
        }
        test.check(rejected && !menu.opened, "invalid payload fails without opening")
        console.log("FOAMY RESULT " + test.checks + " checks")
        console.log("FOAMY DONE")
        Qt.quit()
      }
    }
  }
}
