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
  function said(english, norwegian) { return test.norwegian ? norwegian : english }
  function check(ok, detail) {
    if (!ok) { console.log("FOAMY FAIL " + detail); Qt.exit(1); return }
    checks++
    console.log("PASS " + detail)
  }
  // Holds the current stage until cond is true (or fails after ~10 s).
  property int waits: 0
  function waitFor(cond) {
    if (cond) { waits = 0; return false }
    if (++waits > 40) { check(false, "timed out waiting"); return true }
    stage--
    return true
  }
  function select(id) {
    view.select(view.nthItem(1))
    for (var i = 0; i < 40 && view.selectedRow && view.selectedRow.itemId !== id; i++) view.move(1)
    check(view.selectedRow && view.selectedRow.itemId === id, "select " + id)
  }
  function key(code, modifiers) {
    view.handleKey({key: code, modifiers: modifiers || Qt.NoModifier, text: ""})
  }
  function capture(name, next) {
    var folder = Quickshell.env("FOAMY_MENU_SHOTS")
    if (!folder) { if (next) next(); return }
    test.capturing = true
    view.cardItem.grabToImage(function(result) {
      test.check(result.saveToFile(folder + "/" + name + ".png"), "save " + name)
      test.capturing = false
      if (next) next()
    })
  }
  Foamy.Menu { id: menu; manifest: ({id: "foamy.menu"}) }
  FileView { id: browsed; path: Quickshell.env("FOAMY_BROWSER_FILE"); printErrors: false; blockLoading: true }
  FileView { id: launched; path: Quickshell.env("FOAMY_LAUNCH_FILE"); printErrors: false; blockLoading: true }
  FileView { id: copied; path: Quickshell.env("FOAMY_COPY_FILE"); printErrors: false; blockLoading: true }
  // The services' fetches against launcher.py's local HTTPS server.
  readonly property string fetchUrl: Quickshell.env("FOAMY_FETCH_URL")
  FoamyServices.CalculatorData {
    id: ratesProbe
    cacheDir: Quickshell.env("FOAMY_FETCH_CACHE")
    ratesEnabled: false
    property var said: []
    onMessage: function(level, text, metadata) { ratesProbe.said = ratesProbe.said.concat([text + (metadata && metadata.error ? ": " + metadata.error : "")]) }
  }
  FileView { id: ratesCache; path: Quickshell.env("FOAMY_FETCH_CACHE") + "/currencies.json"; printErrors: false; blockLoading: true }
  FoamyServices.ScopeSource {
    id: suggestProbe
    builtins: [Object.assign({}, Scopes.BUILTINS[2], { suggest: true, suggestUrl: test.fetchUrl + "/ac?q={query}" })]
    property var stored: []
    onSuggestionsChanged: if (suggestions.duckduckgo) stored = stored.concat([suggestions.duckduckgo.query])
  }
  Timer {
    running: true
    repeat: true
    interval: 250
    onTriggered: {
      if (test.capturing) return
      if (!backend.ready || backend.loading) {
        if (++test.attempts > 100) { test.check(false, "backend becomes ready"); Qt.exit(1) }
        return
      }
      switch (test.stage++) {
      case 0:
        test.check(backend.candidates.length > 5, "loads apps and Omarchy commands")
        test.check(backend.paths.data.endsWith("/foamy-menu"), "isolates storage")
        test.check(backend.settings.currencyRates === false && backend.settings.webSearchHistory === false, "settings come from the foamy.menu entry in shell.json")
        test.check(menu.stockMenu.appLibrary !== null, "application library available without host facade")
        view.implicitWidth = Number(Quickshell.env("FOAMY_TEST_WIDTH"))
        view.implicitHeight = 800
        menu.open('{"menu":"root"}')
        break
      case 1:
        test.check(menu.opened && launcher.opened && !menu.stockMenu.opened, "root opens adopted launcher only")
        test.check(view.brandIcon === "\u{f08c7}", "Arch header icon")
        test.check(view.cardWidth <= view.width, "card fits viewport")
        test.check(view.cardItem.activeFocus || view.activeFocusItem !== null, "launcher receives keyboard focus")
        test.check(view.placeholder === test.said("Search for apps and commands…", "Søk etter apper og kommandoer…"), "placeholder follows the language")
        test.check(backend.candidatesById["omarchy:apps"].title === test.said("Apps", "Apper"), "Omarchy menu labels use Omarchy's catalog")
        test.check(backend.candidatesById["builtin:calculator-history"].title === test.said("Calculator History", "Kalkulatorhistorikk"), "built-in titles are translated")
        test.check(backend.scopes.map(function(s) { return s.id }).join() === "ssh,google,duckduckgo,bookmarks", "built-in and user scopes load; enabled:false is skipped")
        test.capture("root", function() { view.setQuery("2 + 3 * 4") })
        break
      case 2:
        test.check(view.selectedRow && view.selectedRow.calcResult === "14", "calculator leads live search")
        var half = backend.calculate("1000.25 * 2")
        test.check(test.norwegian ? /^2\s000,5$/.test(half.result) : half.result === "2,000.5", "answers use the language's separators")
        test.check(half.plain === "2000.5", "the plain answer stays machine-readable")
        test.check(test.norwegian ? backend.calculate("2,5 * 2").result === "5" : backend.calculate("2,5 * 2") === null, "typed numbers follow the language's decimal mark")
        var dayFirst = backend.calculate("dager til 24.12.2030")
        test.check(test.norwegian ? !!dayFirst && dayFirst.result === backend.calculate("2030-12-24 - today").result : dayFirst === null,
          "24.12.2030 is a date only where the language writes the day first")
        test.check(test.norwegian ? backend.calculate("90 min to hours").result === "1,5 timer" : true, "unit names follow the language")
        test.capture("calculator", function() { key(Qt.Key_K, Qt.ControlModifier) })
        break
      case 3:
        test.check(view.actionPanelOpen, "Ctrl+K opens action panel")
        test.capture("actions", function() {
          key(Qt.Key_Escape)
          test.check(!view.actionPanelOpen && menu.opened, "Escape closes panel without closing launcher")
          key(Qt.Key_Return)
        })
        break
      case 4:
        copied.reload()
        test.check(copied.text() === "14", "Enter copies calculation through stdin")
        test.check(!menu.opened, "copy dismisses launcher")
        test.check(backend.callSync("calculator.historyGetAll", null).data.length === 1, "saves calculator history")
        menu.open('{"query":"1/0"}')
        break
      case 5:
        test.check(!view.selectedRow || !view.selectedRow.calcResult, "invalid calculation has no result")
        test.capture("invalid", function() { view.setQuery("<img src=\"https://example.invalid/test\">") })
        break
      case 6:
        test.check(view.query.indexOf("<img") === 0, "markup input remains literal")
        test.check(!backend.callSync("rootSearch.performAction", {id:"missing", action:"open"}).ok, "unknown action reports failure")
        test.capture("no-match", function() { menu.open('{"mode":"select","prompt":"Choose","options":["One","Two"],"width":280}') })
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
        view.request({ id: "omarchy:apps", action: "open", query: "" })
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
        test.capture("apps", function() { view.setQuery("zzzz-no-such-app") })
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
        test.check(view.placeholder === test.said("Search hosts…", "Søk etter verter…"), "scope placeholder")
        if (!test.nativeHelper) {
          // The host list comes from the bundled helper too.
          var state = backend.scopeState("ssh")
          test.check(state.failure === "This plugin's helper isn't available for this CPU." && view.emptyText[1] === state.failure, "without a bundled helper the SSH scope says so")
          view.popToRoot()
          view.setQuery("bookmarks")
          test.stage = 15
          break
        }
        test.check(view.selectedRow && view.selectedRow.itemId === "scope-item:ssh:db", "hosts listed A–Z; wildcards skipped")
        test.check(view.selectedRow.subtitle === "db.internal", "host shows its HostName")
        test.capture("ssh", function() {
          key(Qt.Key_Backspace)
          test.check(view.atRoot && view.query === "", "Backspace on an empty search removes the tag")
          view.setQuery("ssh we")
          key(Qt.Key_Tab)
        })
        break
      case 13:
        test.check(view.view.kind === "scope" && view.query === "we", "text after the keyword carries into the scope")
        test.check(view.selectedRow && view.selectedRow.title === "web", "the scope search narrows the hosts")
        test.check(backend.callSync("rootSearch.search", { query: "web", view: { kind: "root" } }).data.every(function(s) {
          return s.rows.every(function(r) { return r.kind !== "scope-item" })
        }), "hosts stay out of the root search")
        key(Qt.Key_Return)
        break
      case 14:
        launched.reload()
        var argv = launched.text().trim().split("\n")
        test.check(argv[0] === "--app-id=TUI.tile" && /\/bin\/foamy-ssh-connect$/.test(argv[1]) && argv[2] === "web", "Enter connects through the terminal")
        test.check(!menu.opened, "connecting dismisses the launcher")
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("bookmarks")
        break
      case 15:
        test.check(view.selectedRow && view.selectedRow.itemId === "scope:bookmarks", "a user scope is a row in the root search")
        key(Qt.Key_Tab)
        break
      case 16:
        test.check(view.view.kind === "scope" && view.view.scopeId === "bookmarks" && view.selectedRow && view.selectedRow.title === "Omarchy", "Tab on a scope row enters it")
        key(Qt.Key_Escape)
        test.check(view.atRoot, "Escape leaves the scope")
        view.setQuery("g rust & async")
        key(Qt.Key_Tab)
        break
      case 17:
        test.check(view.view.scopeId === "google" && view.query === "rust & async", "g + Tab enters Google with the search")
        test.check(view.selectedRow && view.selectedRow.itemId === "scope-query:google", "the typed text is the first row")
        test.check(backend.callSync("rootSearch.search", { query: view.query, view: view.view }).data.length === 1, "no saved searches or suggestions unless turned on")
        key(Qt.Key_Return)
        break
      case 18:
        browsed.reload()
        test.check(browsed.text().trim() === "https://www.google.com/search?q=rust%20%26%20async", "Enter opens the encoded search URL")
        test.check(!backend.callSync("frecency.get", { id: "scope-item:google:rust & async" }).data, "searches are not saved without history")
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("ddg pasta")
        key(Qt.Key_Tab)
        key(Qt.Key_Return)
        break
      case 19:
        test.check(!!backend.callSync("frecency.get", { id: "scope-item:duckduckgo:pasta" }).data, "history: true saves the search")
        menu.open('{"menu":"root"}')
        view.popToRoot()
        view.setQuery("ddg")
        key(Qt.Key_Tab)
        var saved = backend.callSync("rootSearch.search", { query: "", view: view.view }).data
        test.check(view.view.scopeId === "duckduckgo" && view.query === "", "ddg + Tab enters DuckDuckGo")
        test.check(saved.length === 2 && saved[1].title === "Recent Searches" && saved[1].rows[0].value === "pasta", "saved searches list under Recent Searches")
        test.capture("ddg", function() {
          key(Qt.Key_Escape)
          view.setQuery("zzzz no match")
        })
        break
      case 20:
        for (var step = 0; step < 20 && view.selectedRow && view.selectedRow.itemId !== "scope-query:google"; step++) view.move(1)
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
        test.capture("settings", function() {
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
        if (test.waitFor(backend.settingsEntry.width === 1200 && backend.settingsEntry.clockFormat === "12h" && backend.settingsEntry.webSearchHistory === true)) break
        test.check(menu.stockMenu.configuredWidth === 1200, "the bar entry in shell.json holds the settings")
        test.select("setting:width")
        test.check(view.selectedRow.typeLabel === "1200 px", "the row shows the saved value")
        key(Qt.Key_K, Qt.ControlModifier)
        test.check(view.actionPanelOpen && view.actions.some(function(a) { return a.id === "reset-setting" }), "a changed setting offers Reset to Default")
        key(Qt.Key_Escape)
        key(Qt.Key_Escape)
        launcher.run("builtin:omarchy-menu")
        break
      case 23:
        test.check(menu.stockMenu.opened && !launcher.opened, "original-menu action survives launcher close")
        menu.open('{"menu":"system"}')
        break
      case 24:
        test.check(menu.stockMenu.opened && !launcher.opened, "named stock routes remain supported")
        ratesProbe.ratesUrl = test.fetchUrl + "/endless"
        ratesProbe.fetchRates()
        break
      case 25:
        if (test.waitFor(!ratesProbe.fetching && ratesProbe.said.length > 0)) break
        test.check(ratesProbe.rates === null && ratesProbe.said[ratesProbe.said.length - 1] === "could not fetch exchange rates: reply is over " + Fetch.MAX_BYTES + " bytes",
          "an endless rates reply stops at the cap and fails: " + ratesProbe.said)
        ratesProbe.ratesUrl = test.fetchUrl + "/v1/latest"
        ratesProbe.fetchRates()
        break
      case 26:
        if (test.waitFor(!ratesProbe.fetching && ratesProbe.said.length > 1)) break
        test.check(ratesProbe.rates && ratesProbe.rates.base === "EUR" && ratesProbe.rates.rates.USD === 1.08 && ratesProbe.said[1] === "exchange rates updated",
          "a normal rates reply still parses: " + ratesProbe.said)
        ratesCache.reload()
        test.check(JSON.parse(ratesCache.text()).rates.NOK === 11.7, "fetched rates are cached")
        suggestProbe.suggest("duckduckgo", "huge pasta")
        break
      case 27:
        var huge = suggestProbe.suggestions.duckduckgo
        if (test.waitFor(huge && huge.query === "huge pasta")) break
        test.check(huge.items.length === 0, "an endless suggestion reply stops at the cap and lists nothing")
        suggestProbe.suggest("duckduckgo", "slow pasta")
        break
      case 28:
        // "slow pasta" is in flight (2 s); the next text replaces it.
        suggestProbe.suggest("duckduckgo", "pasta")
        break
      case 29:
        var normal = suggestProbe.suggestions.duckduckgo
        if (test.waitFor(normal && normal.query === "pasta")) break
        test.check(normal.items.join() === "pasta one,pasta two", "a normal suggestion reply still parses")
        test.check(suggestProbe.stored.join() === "huge pasta,pasta", "a replaced request's reply is dropped: " + suggestProbe.stored)
        menu.close()
        test.check(!menu.opened, "close dismisses either view")
        var rejected = false
        try { menu.open("[]") } catch (e) { rejected = true }
        test.check(rejected && !menu.opened, "invalid payload fails without opening")
        console.log("FOAMY RESULT " + test.checks + " checks")
        console.log("FOAMY DONE")
        Qt.quit()
      }
    }
  }
}
