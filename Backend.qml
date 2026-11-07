import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "core/Rpc.js" as Rpc
import "core/Paths.js" as Paths
import "core/Log.js" as Log
import "core/Schema.js" as Schema
import "core/Ranker.js" as Ranker
import "core/FleaSearch.js" as FleaSearch
import "core/Frecency.js" as Frecency
import "core/OmarchyMenu.js" as OmarchyMenu
import "core/RootSearch.js" as RootSearch
import "core/Calculator.js" as Calculator
import "core/Scopes.js" as Scopes
import "core/Settings.js" as Settings
import "kit/FoamyPrefs.js" as Prefs
import "services"
import "kit"

Item {
  id: backend

  readonly property string version: "2.1.1"
  readonly property var paths: Paths.resolve(function(name) { return Quickshell.env(name) })
  readonly property string desktop: Quickshell.env("HYPRLAND_INSTANCE_SIGNATURE") ? "hyprland" : "unknown"
  // This plugin's directory, for {plugin} in scope commands.
  readonly property string pluginDir: decodeURIComponent(Qt.resolvedUrl(".").toString().replace(/^file:\/\//, "")).replace(/\/+$/, "")

  property var appLibrary: null
  property var summon: null

  // The foamy.menu entry in ~/.config/omarchy/shell.json (StockMenu reads it)
  // and every setting resolved from it: core/Settings.js lists them.
  property var settingsEntry: ({})
  // The shell facade (not the launcher's wrapper): saves go inline through it.
  property var hostShell: null
  // Values saved but not yet read back from shell.json count already, and so
  // do saves still queued behind a running `omarchy bar set` (a second → must
  // step from the first one's value).
  readonly property var settings: Settings.resolve(Prefs, Prefs.overlay(prefs.effectiveSettings, backend.queuedValues(prefs.waiting)))
  function queuedValues(waiting) {
    var out = ({})
    for (var i = 0; i < (waiting || []).length; i++) out[waiting[i].key] = waiting[i].value
    return out
  }
  // Built-in scopes with the SSH and web-search settings applied.
  readonly property var builtinScopes: Settings.applyToScopes(Scopes.BUILTINS, backend.settings)
  property bool directoriesReady: false
  readonly property bool ready: directoriesReady && settingsStore.loaded && frecencyStore.loaded && calculatorStore.loaded

  readonly property var registry: Rpc.createRegistry()
  readonly property double startedAt: Date.now()
  readonly property var deps: ({ Ranker: Ranker, Frecency: Frecency, OmarchyMenu: OmarchyMenu, Scopes: Scopes, Settings: Settings })

  property var candidates: []
  property var candidatesById: ({})
  property int candidatesRevision: 0
  readonly property bool loading: menuSource.loading || scopeSource.loading || nativeSearch.pending !== null
  // Enabled scopes, for Tab on a keyword in the root search.
  readonly property var scopes: scopeSource.scopes
  // Bumped when exchange rates or zone offsets arrive, so an open
  // calculator row re-evaluates.
  readonly property int calculatorRevision: (calculatorData.rates ? 1 : 0) + calculatorData.ratesFetchedAt + calculatorData.zonesAt

  signal notification(string method, var data)


  function call(method, data) { return Rpc.call(backend.registry, method, data) }
  function callSync(method, data) { return Rpc.callSync(backend.registry, method, data) }
  function cancelSearch() { nativeSearch.cancel() }

  function searchAsync(data, callback) {
    nativeSearch.cancel()
    var query = String(data && data.query || "").trim()
    var view = data && data.view
    if (!query || (view && view.kind !== "root")) {
      callback(backend.callSync("rootSearch.search", data))
      return
    }
    nativeSearch.search(Ranker.transliterate(query.toLowerCase()), backend.searchContext().sensitivity, function(matches) {
      callback(backend.callSync("rootSearch.search", Object.assign({}, data, { fleaHits: matches })))
    })
  }

  NativeSearch {
    id: nativeSearch
    onFailed: function(message) { backend.log("warning", "search", message) }
  }
  function subscribe(method, callback) { return Rpc.subscribe(backend.registry, method, callback) }

  function emit(method, data) {
    Rpc.emit(backend.registry, method, data, function(m, error) {
      backend.log("error", "rpc", "subscriber of " + m + " threw: " + error)
    })
    backend.notification(method, data)
  }

  function log(level, category, message, metadata) {
    if (!Log.shouldLog(level, backend.settings.logLevel)) return
    var line = Log.format(level, category, message, metadata)
    var i = Log.levelIndex(level)
    if (i >= Log.levelIndex("error")) console.error(line)
    else if (i >= Log.levelIndex("warning")) console.warn(line)
    else if (i >= Log.levelIndex("info")) console.info(line)
    else console.log(line)
  }


  function appEntries() {
    if (backend.appLibrary) return backend.appLibrary.sortedEntries("").map(function(row) { return row.entry })
    return (DesktopEntries.applications.values || []).filter(function(e) { return !e.noDisplay })
  }

  function rebuildCandidates() {
    var next = []
    var apps = backend.appEntries()
    for (var i = 0; i < apps.length; i++) if (apps[i] && apps[i].id) next.push(RootSearch.appCandidate(apps[i]))
    next = next.concat(RootSearch.menuCandidates(menuSource.tree, menuSource.guards, menuSource.providerItems, backend.deps))
    for (var b = 0; b < RootSearch.BUILTINS.length; b++) next.push(RootSearch.builtinCandidate(RootSearch.BUILTINS[b], backend.tr))
    for (var s = 0; s < scopeSource.scopes.length; s++) next.push(Scopes.scopeCandidate(scopeSource.scopes[s], backend.tr))
    var byId = ({})
    for (var j = 0; j < next.length; j++) byId[next[j].id] = next[j]
    var entries = FleaSearch.entries(next, Ranker.transliterate)
    nativeSearch.cancel()
    backend.candidates = next
    backend.candidatesById = byId
    nativeSearch.ids = next.map(function(c) { return c.id })
    nativeSearch.entries = entries
    backend.candidatesRevision++
  }

  Timer {
    id: rebuildTimer
    interval: 30
    onTriggered: backend.rebuildCandidates()
  }

  function searchContext() {
    return {
      commands: settingsStore.loaded ? settingsStore.doc.commands : ({}),
      frecency: frecencyStore.loaded ? frecencyStore.doc.items : ({}),
      nowMs: Date.now(),
      sensitivity: backend.settings.rootSearchSensitivity,
      // Query scopes (web search) offer the typed text under "Use “…” with…".
      searchScopes: scopeSource.scopes.filter(Scopes.isQuery),
      t: backend.tr
    }
  }

  function decorated(id) {
    var c = backend.candidatesById[id] || backend.scopeItem(id) || backend.settingItem(id)
    return c ? RootSearch.decorate(c, backend.searchContext(), backend.deps) : null
  }

  // Plain English text in the picked language (the catalogs are keyed by it).
  function tr(text, values) { return FoamyI18n.t(text, values) }

  // -------------------------------------------------------------- settings

  // A row of the settings view, by id.
  function settingItem(id) {
    var text = String(id)
    if (text.indexOf("setting:") === 0) {
      var f = Settings.field(text.slice("setting:".length))
      return f && !f.hidden ? RootSearch.settingCandidate(f, backend.settings[f.key], backend.tr, backend.deps) : null
    }
    if (text.indexOf("settings-action:") === 0) {
      var a = RootSearch.SETTINGS_ACTIONS.filter(function(x) { return x.id === text })[0]
      return a ? { id: a.id, type: "command", kind: "settings-action", title: backend.tr(a.title), subtitle: "", keywords: [], typeLabel: "Command", glyph: a.glyph, rootSearch: { when: "never" } } : null
    }
    return null
  }

  // Saves one setting into the foamy.menu entry of shell.json, inline through
  // the shell when it allows, else with `omarchy bar set`. The row shows the
  // new value at once; a failure comes back as a toast.
  function saveSetting(f, value) {
    if (!prefs.save(f.key, value)) return { toast: { style: "failure", title: backend.tr(prefs.error || Prefs.NOT_ALLOWED) } }
    return {}
  }

  function settingAction(candidate, action, data) {
    var f = Settings.field(candidate.settingKey)
    var value = backend.settings[f.key]
    switch (action) {
      case "open":
        if (f.type === "boolean" || f.type === "enum") return backend.saveSetting(f, Settings.stepped(f, value, 1))
        var hint = Settings.hint(f)
        return { push: { kind: "setting-edit", key: f.key, title: backend.tr(f.title), value: String(value), hint: backend.tr(hint[0], hint[1]) } }
      case "setting-next":
      case "setting-previous":
        var next = Settings.stepped(f, value, action === "setting-next" ? 1 : -1)
        return next === null ? {} : backend.saveSetting(f, next)
      case "set":
        var parsed = Settings.parse(f, data && data.value)
        if (parsed === undefined || !Prefs.valid(Settings.fields, f.key, parsed)) {
          var range = Settings.hint(f)
          return { toast: { style: "failure", title: backend.tr(range[0], range[1]) } }
        }
        var saved = backend.saveSetting(f, parsed)
        return saved.toast ? saved : { pop: true }
      case "reset-setting":
        return backend.saveSetting(f, f.defaultValue)
      case "copy-setting-command":
        var shown = typeof f.defaultValue === "string" ? String(value) : JSON.stringify(value)
        var command = "omarchy bar set foamy.menu " + f.key + " " + (typeof f.defaultValue === "string" ? "'" + shown.replace(/'/g, "'\\''") + "'" : shown + " --json")
        clipboard.copy(command)
        return { close: true, hud: backend.tr("Copied to Clipboard") }
    }
    throw new Error("Unknown action " + action)
  }

  function settingsAction(id) {
    if (id === "settings-action:open-scopes") {
      Util.execArgv(["xdg-open", backend.paths.scopes])
      return { close: true }
    }
    if (id === "settings-action:clear-searches") {
      // Disabled scopes too: their saved searches are still stored.
      var prefixes = scopeSource.queryScopeIds.map(function(id) { return Scopes.itemId(id, "") })
      frecencyStore.update(function(doc) {
        for (var key in doc.items)
          for (var i = 0; i < prefixes.length; i++) if (key.indexOf(prefixes[i]) === 0) delete doc.items[key]
      })
      return { toast: { style: "success", title: backend.tr("Search history cleared") } }
    }
    throw new Error("Unknown command " + id)
  }

  QtObject {
    id: prefsHost
    property var shell: backend.hostShell
  }

  FoamyPrefsQueue {
    id: prefs
    bar: prefsHost
    moduleName: "foamy.menu"
    fields: Settings.fields
    settings: backend.settingsEntry
    onFailed: function(key, value, error) {
      backend.log("warning", "settings", "saving " + key + " failed: " + error)
      backend.emit("settings.saveFailed", { key: key, error: backend.tr(error) })
    }
  }

  // ---------------------------------------------------------------- scopes

  // A scope's items as candidates, rebuilt when its items change.
  readonly property var scopeItemCache: ({})
  function scopeItems(scopeId) {
    var scope = scopeSource.scope(scopeId)
    var list = scopeSource.items[scopeId]
    if (!scope || !list) return []
    var cached = backend.scopeItemCache[scopeId]
    if (cached && cached.list === list && cached.scope === scope) return cached.candidates
    var candidates = list.map(function(item) { return Scopes.itemCandidate(scope, item, backend.tr) })
    var byId = ({})
    for (var i = 0; i < candidates.length; i++) byId[candidates[i].id] = candidates[i]
    // Filled in place: bindings that read actions must not re-run on it.
    backend.scopeItemCache[scopeId] = { list: list, scope: scope, candidates: candidates, byId: byId }
    return candidates
  }

  function scopeItem(id) {
    if (String(id).indexOf("scope-query:") === 0) {
      var queryScope = scopeSource.scope(String(id).slice("scope-query:".length))
      return queryScope && Scopes.isQuery(queryScope) ? Scopes.queryCandidate(queryScope, "", backend.tr, false) : null
    }
    if (String(id).indexOf("scope-item:") !== 0) return null
    var scopeId = String(id).slice("scope-item:".length).split(":")[0]
    backend.scopeItems(scopeId)
    var cached = backend.scopeItemCache[scopeId]
    return cached ? cached.byId[id] || null : null
  }

  function openScope(candidate) {
    var scope = scopeSource.scope(candidate.scopeId)
    if (!scope) throw new Error("Scope " + candidate.scopeId + " is not available")
    scopeSource.refresh(scope.id)
    return { push: { kind: "scope", scopeId: scope.id, title: backend.tr(scope.title), glyph: scope.icon } }
  }

  // A query scope's sections: the typed text, saved searches, suggestions.
  // Their candidates are kept for the actions that follow.
  function querySearch(scope, query, ctx) {
    var q = String(query || "").trim()
    var saved = scope.history && frecencyStore.loaded ? Scopes.historyCandidates(scope, frecencyStore.doc.items, backend.tr) : []
    var suggestions = []
    if (scope.suggest && q) {
      var cached = scopeSource.suggestions[scope.id]
      if (cached && cached.query === q) suggestions = cached.items
      else scopeSource.suggest(scope.id, q)
    }
    var sections = RootSearch.querySections(scope, q, saved, suggestions, ctx, backend.deps)
    var byId = ({})
    for (var s = 0; s < sections.length; s++)
      for (var r = 0; r < sections[s].rows.length; r++) byId[sections[s].rows[r].candidate.id] = sections[s].rows[r].candidate
    // Filled in place, as scopeItems does.
    backend.scopeItemCache[scope.id] = { list: null, scope: scope, candidates: [], byId: byId }
    return sections
  }

  // A search run in a query scope, saved when the scope keeps history.
  function rememberSearch(scope, value) {
    if (!scope.history || !frecencyStore.loaded) return
    backend.recordVisit(Scopes.itemId(scope.id, value), "")
    var overflow = Scopes.historyOverflow(scope.id, frecencyStore.doc.items)
    if (overflow.length) frecencyStore.update(function(doc) { for (var i = 0; i < overflow.length; i++) delete doc.items[overflow[i]] })
  }

  // Enter or an extra action on an item inside a scope. The value goes into
  // argv as one argument; it never passes through a shell. The typed-text row
  // of a query scope takes its value from the search field.
  function scopeItemAction(candidate, action, query) {
    var scope = scopeSource.scope(candidate.scopeId)
    if (!scope) throw new Error("Scope " + candidate.scopeId + " is not available")
    var searching = Scopes.isQuery(scope)
    if (action === "delete-history" && candidate.saved) {
      frecencyStore.update(function(doc) { delete doc.items[candidate.id] })
      return { toast: { style: "success", title: backend.tr("Removed from history") } }
    }
    if (action === "clear-history") {
      var prefix = Scopes.itemId(scope.id, "")
      frecencyStore.update(function(doc) { for (var key in doc.items) if (key.indexOf(prefix) === 0) delete doc.items[key] })
      return { toast: { style: "success", title: backend.tr("Search history cleared") } }
    }
    var value = candidate.kind === "scope-query" ? String(query || "").trim() : candidate.value
    if (!value && candidate.kind === "scope-query" && action === "open" && scope.home) {
      Util.execArgv(Scopes.fill(scope.home, "", backend.pluginDir))
      return { close: true }
    }
    if (!value) return { toast: { style: "failure", title: backend.tr("Type something to search") } }
    if (!Scopes.valueAllowed(scope, value)) return { toast: { style: "failure", title: backend.tr("“%1” is not a valid value for %2", [value, backend.tr(scope.title)]) } }
    var extra = null
    if (action !== "open") {
      extra = scope.actions[Number(action.slice("scope-action:".length))]
      if (!extra) throw new Error("Unknown action " + action)
      if (extra.copy !== undefined) {
        clipboard.copy(Scopes.fillText(extra.copy, value))
        return { close: true, hud: backend.tr("Copied to Clipboard") }
      }
    }
    // Query scopes save searches only when asked to; other scopes rank items.
    if (searching) backend.rememberSearch(scope, value)
    else backend.recordVisit(candidate.id, query)
    Util.execArgv(Scopes.fill(extra ? extra.open : scope.open, value, backend.pluginDir))
    return { close: true }
  }

  // ------------------------------------------------------------ calculator

  // 12- or 24-hour clock from the clockFormat setting, else the Qt locale.
  readonly property bool hour12: backend.settings.clockFormat === "auto"
    ? Qt.locale().timeFormat(Locale.ShortFormat).toLowerCase().indexOf("ap") >= 0
    : backend.settings.clockFormat === "12h"

  function calculatorEnv() {
    return {
      nowMs: Date.now(),
      localOffset: -new Date().getTimezoneOffset(),
      hour12: backend.hour12,
      rates: backend.settings.currencyRates ? calculatorData.rates : null,
      zones: calculatorData.zones,
      remToPxRate: backend.settings.remToPxRate,
      workHoursPerDay: backend.settings.workHoursPerDay,
      // Answers are written as the picked language writes numbers and dates.
      decimal: backend.numberLocale.decimalPoint,
      groupSeparator: backend.numberLocale.groupSeparator,
      // "24.12" is a date where the language writes the day first.
      dayFirst: /^d/i.test(backend.numberLocale.dateFormat(Locale.ShortFormat)),
      formatDate: function(ms) { return new Date(ms).toLocaleDateString(backend.numberLocale, Locale.LongFormat) },
      translate: function(text) { return backend.tr(text) }
    }
  }

  readonly property var numberLocale: Qt.locale(String(FoamyI18n.formatLocale || "en-US").replace("-", "_"))

  function calculate(query) {
    try {
      return Calculator.evaluate(query, backend.calculatorEnv())
    } catch (e) {
      backend.log("error", "calculator", "evaluating failed: " + e, { query: query })
      return null
    }
  }

  function saveCalculation(entry) {
    calculatorStore.update(function(doc) {
      doc.history = Calculator.pushHistory(doc.history, {
        id: String(Date.now()), query: entry.query, result: entry.result, copy: entry.copy, plain: entry.plain, kind: entry.kind
      }, Date.now())
    })
    backend.emit("calculator.historyStateChanged", null)
  }

  // An action on the inline Calculator row or a Calculator History entry.
  // entry: {query, result, copy, kind}; history: whether it is saved already.
  function calculatorAction(action, entry, historyId) {
    switch (action) {
      case "open":
      case "copy-answer":
        if (!historyId) backend.saveCalculation(entry)
        clipboard.copy(entry.copy)
        return { close: true, hud: backend.tr("Copied to Clipboard") }
      case "paste-answer":
        if (!historyId) backend.saveCalculation(entry)
        // Copies, waits for our window to unmap, then pastes.
        clipboard.paste(entry.copy)
        return { close: true }
      case "copy-plain":
        if (!historyId) backend.saveCalculation(entry)
        clipboard.copy(entry.plain || entry.copy)
        return { close: true, hud: backend.tr("Copied to Clipboard") }
      case "copy-question-answer":
        if (!historyId) backend.saveCalculation(entry)
        clipboard.copy(entry.query + " = " + entry.result)
        return { close: true, hud: backend.tr("Copied to Clipboard") }
      case "open-history":
        return { push: { kind: "calculator-history", title: backend.tr("Calculator History") } }
      case "delete-entry":
        calculatorStore.update(function(doc) { doc.history = doc.history.filter(function(h) { return h.id !== historyId }) })
        backend.emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: backend.tr("Entry deleted") } }
      case "delete-all-entries":
        calculatorStore.update(function(doc) { doc.history = [] })
        backend.emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: backend.tr("History cleared") } }
    }
    throw new Error("Unknown action " + action)
  }

  function historyEntry(id) {
    var key = String(id).slice("calculator-history:".length)
    var list = calculatorStore.loaded ? calculatorStore.doc.history : []
    for (var i = 0; i < list.length; i++) if (list[i].id === key) return list[i]
    return null
  }

  // ------------------------------------------------------------- execution

  function summonPlugin(id, payload) {
    if (backend.summon && backend.summon(id, payload)) return
    Quickshell.execDetached(["omarchy-shell", "shell", "summon", id, payload || "{}"])
  }

  function runShell(command) {
    var summon = OmarchyMenu.summonAction(command)
    if (summon) backend.summonPlugin(summon.id, summon.payload)
    else Util.execDetached(command)
  }

  function recordVisit(id, query) {
    if (!frecencyStore.loaded) return
    frecencyStore.update(function(doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, Date.now(), query || "")
      if (query) doc.searchHistory = Schema.pushSearchHistory(doc.searchHistory, query)
    })
  }

  function updateCommand(id, mutator) {
    settingsStore.update(function(doc) {
      var current = doc.commands[id] || {}
      var next = mutator(JSON.parse(JSON.stringify(current)))
      var empty = true
      for (var k in next) if (next[k] !== null && next[k] !== undefined && next[k] !== "") empty = false
      if (empty) delete doc.commands[id]
      else doc.commands[id] = next
    })
    backend.emit("settings.commandSettingsChanged", { commandId: id })
  }

  function omarchyRouteFor(candidate) {
    if (candidate.kind === "omarchy-action") {
      var item = menuSource.tree.items[candidate.menuId]
      return item && item.parent ? item.parent : "root"
    }
    return candidate.kind === "omarchy-link" ? candidate.target : candidate.menuId
  }

  function openMenu(item) {
    if (item.provider && !OmarchyMenu.PROVIDERS[item.provider]) {
      backend.summonPlugin("omarchy.menu", JSON.stringify({ menu: item.id }))
      return { close: true }
    }
    return { push: { kind: "menu", menuId: item.id, title: item.label } }
  }

  function launchApp(candidate) {
    if (backend.appLibrary) backend.appLibrary.launch(candidate.appId, candidate.title)
    else Util.execArgv(["uwsm-app", "--", "gtk-launch", candidate.appId + ".desktop"])
  }

  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    var candidate = backend.decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (candidate.kind === "setting") return backend.settingAction(candidate, action, data)
    if (candidate.kind === "settings-action" && action === "open") return backend.settingsAction(id)
    if ((candidate.kind === "scope-item" || candidate.kind === "scope-query")
        && (action === "open" || action.indexOf("scope-action:") === 0 || action === "delete-history" || action === "clear-history"))
      return backend.scopeItemAction(candidate, action, query)

    if (action === "open") {
      switch (candidate.kind) {
        case "scope":
          backend.recordVisit(id, query)
          return backend.openScope(candidate)
        case "app":
          backend.recordVisit(id, query)
          appFocuser.open(candidate)
          return { close: true }
        case "omarchy-action":
          if (candidate.disabled) return { toast: { style: "failure", title: backend.tr("%1 is already set up", [candidate.title]) } }
          backend.recordVisit(id, query)
          // Apps opens as a grid inside the launcher, not the dock's own window.
          if (RootSearch.isAppGridItem(candidate)) return { push: { kind: "apps", title: candidate.title } }
          backend.runShell(candidate.action)
          return { close: true }
        case "omarchy-menu":
          backend.recordVisit(id, query)
          return backend.openMenu(menuSource.tree.items[candidate.menuId])
        case "omarchy-link":
          backend.recordVisit(id, query)
          var target = menuSource.tree.items[candidate.target]
          if (!target) return { toast: { style: "failure", title: backend.tr("Menu %1 not found", [candidate.target]) } }
          return backend.openMenu(target)
        case "builtin":
          backend.recordVisit(id, query)
          if (candidate.run.push) return { push: candidate.run.push }
          if (candidate.run.summon) backend.summonPlugin(candidate.run.summon, candidate.run.payload || "{}")
          return { close: true }
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "open-new":
        backend.recordVisit(id, query)
        backend.launchApp(candidate)
        return { close: true }
      case "open-in-omarchy-menu":
        backend.summonPlugin("omarchy.menu", JSON.stringify({ menu: backend.omarchyRouteFor(candidate) }))
        return { close: true }
      case "copy-command":
      case "copy-id":
        clipboard.copy(action === "copy-id" ? candidate.appId + ".desktop" : candidate.action)
        return { close: true, hud: backend.tr("Copied to Clipboard") }
      case "favorite-add":
      case "favorite-remove":
      case "favorite-up":
      case "favorite-down":
        var orders = RootSearch.reorderFavorites(settingsStore.doc.commands, id, action)
        settingsStore.update(function(doc) {
          for (var key in orders) {
            var entry = doc.commands[key] || {}
            if (orders[key] === null) delete entry.favoriteOrder
            else entry.favoriteOrder = orders[key]
            if (Object.keys(entry).length === 0) delete doc.commands[key]
            else doc.commands[key] = entry
          }
        })
        var titles = { "favorite-add": "Added to Favorites", "favorite-remove": "Removed from Favorites", "favorite-up": "Moved Up", "favorite-down": "Moved Down" }
        return { toast: { style: "success", title: backend.tr(titles[action]) } }
      case "set-alias":
        return { push: { kind: "alias", commandId: id, title: backend.tr("Alias for %1", [candidate.title]), value: candidate.alias } }
      case "remove-alias":
        backend.updateCommand(id, function(s) { delete s.alias; return s })
        return { toast: { style: "success", title: backend.tr("Alias removed") } }
      case "reset-ranking":
        frecencyStore.update(function(doc) { delete doc.items[id] })
        return { toast: { style: "success", title: backend.tr("Ranking reset") } }
      case "disable":
        backend.updateCommand(id, function(s) { s.enabled = false; return s })
        // Undo on Ctrl+T: there is no settings window to re-enable it yet.
        return { toast: { style: "success", title: backend.tr("%1 disabled", [candidate.title]), actions: [
          { id: "undo", title: backend.tr("Undo"), done: backend.tr("%1 enabled", [candidate.title]),
            call: { method: "settings.updateCommandSettings", data: { commandId: id, enabled: true } } }
        ] } }
    }
    throw new Error("Unknown action " + action)
  }


  function registerServices() {
    Rpc.register(backend.registry, "system", {
      healthPing: function() { return null },
      healthDatabase: function() {
        var t0 = Date.now()
        JSON.stringify(settingsStore.doc)
        JSON.stringify(frecencyStore.doc)
        return {
          workMs: Date.now() - t0,
          settings: { loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError },
          frecency: { loaded: frecencyStore.loaded, readOnly: frecencyStore.readOnly, error: frecencyStore.lastError },
          loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError
        }
      },
      info: function() {
        return {
          version: backend.version,
          desktop: backend.desktop,
          ready: backend.ready,
          uptimeMs: Date.now() - backend.startedAt,
          candidates: backend.candidates.length,
          appLibrary: !!backend.appLibrary,
          methods: Rpc.methods(backend.registry)
        }
      },
      getPaths: function() { return backend.paths }
    })

    Rpc.register(backend.registry, "settings", {
      // Launcher behaviour: the shell.json settings, with zoom (Ctrl +/-) from
      // the launcher's own state.
      getGeneralSettings: function() {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        return Object.assign({}, backend.settings, { uiZoom: settingsStore.doc.general.uiZoom })
      },
      updateGeneralSettings: function(data) {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        if (settingsStore.readOnly) throw new Error("settings are read-only: " + (settingsStore.lastError || "written by a newer build"))
        var patch = data && typeof data === "object" ? data : {}
        for (var key in patch) {
          if (key !== "uiZoom") throw new Error(key + " is set in shell.json: omarchy bar set foamy.menu " + key + " <value> (add --json for true, false and numbers)")
          if (typeof patch.uiZoom !== "number" || !isFinite(patch.uiZoom)) throw new Error("uiZoom must be a number")
        }
        settingsStore.update(function(doc) { if (patch.uiZoom !== undefined) doc.general.uiZoom = patch.uiZoom })
        backend.emit("settings.generalSettingsChanged", null)
        return { uiZoom: settingsStore.doc.general.uiZoom }
      },
      getAllCommandSettings: function() { return settingsStore.doc.commands },
      getCommandSettings: function(data) { return settingsStore.doc.commands[String(data && data.commandId || "")] || {} },
      updateCommandSettings: function(data) {
        var id = String(data && data.commandId || "")
        if (!backend.candidatesById[id]) throw new Error("Unknown command " + id)
        if (data.alias !== undefined && data.alias !== null) {
          var alias = String(data.alias).trim().toLowerCase()
          if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
          var commands = settingsStore.doc.commands
          for (var other in commands) {
            if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((backend.candidatesById[other] || {}).title || other))
          }
        }
        backend.updateCommand(id, function(s) {
          if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
          if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
          return s
        })
        return settingsStore.doc.commands[id] || {}
      }
    })

    Rpc.register(backend.registry, "rootSearch", {
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = backend.searchContext()
        if (data && data.fleaHits) ctx.fleaHits = data.fleaHits
        var sections
        if (view && view.kind === "menu") sections = RootSearch.submenuSections(backend.candidates, view.menuId, query, ctx, backend.deps)
        else if (view && view.kind === "scope") {
          var scope = scopeSource.scope(view.scopeId)
          if (scope && Scopes.isQuery(scope)) sections = backend.querySearch(scope, query, ctx)
          else sections = scope ? RootSearch.scopeSections(backend.scopeItems(scope.id), query, ctx, backend.deps, backend.tr(scope.itemsTitle)) : []
        }
        else if (view && view.kind === "settings") sections = RootSearch.settingsSections(backend.settings, query, ctx, backend.deps)
        else if (view && view.kind === "apps") sections = RootSearch.appGridSections(backend.candidates, query, ctx, backend.deps)
        else if (view && view.kind === "calculator-history") sections = RootSearch.historySections(calculatorStore.doc.history, query, ctx.nowMs, Calculator.filterHistory)
        else {
          ctx.filter = String(data && data.filter || "all")
          if (query.trim() && ctx.filter === "all") ctx.calculation = backend.calculate(query)
          sections = RootSearch.rootSections(backend.candidates, query, ctx, backend.deps)
        }
        return sections.map(function(s) {
          return { id: s.id, title: s.title, titleValues: s.titleValues || null, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId === RootSearch.CALCULATOR_ID) return RootSearch.actionsFor({ kind: "calculator" })
        if (rowId.indexOf("calculator-history:") === 0) return RootSearch.actionsFor({ kind: "calculator-history" })
        var candidate = backend.decorated(rowId)
        if (!candidate) throw new Error("Unknown command " + rowId)
        return RootSearch.actionsFor(candidate)
      },
      getItemInfo: function(data) {
        var rowId = String(data && data.id || "")
        var nowMs = Date.now()
        if (rowId === RootSearch.CALCULATOR_ID) {
          var calc = backend.calculate(String(data.query || ""))
          return calc ? RootSearch.aboutFor(RootSearch.calculatorCandidate(calc), nowMs) : []
        }
        if (rowId.indexOf("calculator-history:") === 0) {
          var entry = backend.historyEntry(rowId)
          return entry ? RootSearch.aboutFor(RootSearch.historyCandidate(entry, nowMs), nowMs) : []
        }
        var candidate = backend.decorated(rowId)
        if (!candidate) throw new Error("Unknown command " + rowId)
        if (candidate.kind === "scope-query") candidate.value = String(data.query || "").trim()
        return RootSearch.aboutFor(candidate, nowMs)
      },
      performAction: function(data) {
        // Destructive commands come back as a confirmation unless confirmed.
        if (!(data && data.confirmed)) {
          var confirm = RootSearch.confirmationFor(String(data && data.id || ""), String(data && data.action || "open"))
          if (confirm) return { confirm: confirm }
        }
        // The calculator row is the query itself, evaluated again.
        if (data && data.id === RootSearch.CALCULATOR_ID) {
          var calc = backend.calculate(String(data.query || ""))
          if (!calc) throw new Error("Nothing to calculate")
          return backend.calculatorAction(String(data.action || "open"), { query: calc.input, result: calc.result, copy: calc.copy, plain: calc.plain, kind: calc.kind }, "")
        }
        if (data && String(data.id).indexOf("calculator-history:") === 0) {
          var entry = backend.historyEntry(data.id)
          if (!entry) throw new Error("No such history entry")
          return backend.calculatorAction(String(data.action || "open"), entry, entry.id)
        }
        return backend.performAction(data)
      },
      getSearchHistory: function() { return frecencyStore.loaded ? frecencyStore.doc.searchHistory : [] }
    })

    // Names from Raycast's calculator namespace (ref 02 §2).
    Rpc.register(backend.registry, "calculator", {
      calculate: function(data) { return backend.calculate(String(data && data.query || "")) },
      historyGetAll: function() { return calculatorStore.loaded ? calculatorStore.doc.history : [] },
      historyDelete: function(data) { return backend.calculatorAction("delete-entry", null, String(data && data.id || "")) },
      historyDeleteAll: function() { return backend.calculatorAction("delete-all-entries", null, "") },
      refreshCurrencies: function() {
        if (!backend.settings.currencyRates) throw new Error("currencyRates is off: omarchy bar set foamy.menu currencyRates true --json")
        calculatorData.fetchRates()
        return null
      },
      getCurrencies: function() {
        var r = calculatorData.rates
        return {
          enabled: backend.settings.currencyRates,
          date: r ? r.date : null,
          base: r ? r.base : null,
          currencies: r ? Object.keys(r.rates).concat([r.base]).sort() : [],
          fetchedAt: calculatorData.ratesFetchedAt || null,
          zones: Object.keys(calculatorData.zones).length
        }
      }
    })

    Rpc.register(backend.registry, "frecency", {
      visit: function(data) { backend.recordVisit(String(data.id), String(data.query || "")); return null },
      get: function(data) {
        var entry = frecencyStore.doc.items[String(data && data.id || "")]
        return entry ? { anchor: entry.anchor, openedAt: entry.openedAt, score: Frecency.score(entry.anchor, Date.now() / 1000), searchTerms: entry.searchTerms } : null
      }
    })
  }

  Component.onCompleted: {
    registerServices()
    mkdirs.running = true
  }

  onAppLibraryChanged: rebuildTimer.restart()

  // Built-in and scope titles are translated into the candidates.
  Connections {
    target: FoamyI18n
    function onLanguageChanged() { rebuildTimer.restart() }
  }

  Connections {
    target: backend.appLibrary
    ignoreUnknownSignals: true
    function onAppsChanged() { rebuildTimer.restart() }
  }

  Connections {
    target: backend.appLibrary ? null : DesktopEntries.applications
    ignoreUnknownSignals: true
    function onValuesChanged() { rebuildTimer.restart() }
  }

  Component.onDestruction: { settingsStore.flush(); frecencyStore.flush(); calculatorStore.flush() }
  onNotification: function(method, data) {
    if (method === "window.visibilityChanged" && data && data.visible) {
      menuSource.refresh()
      calculatorData.refresh()
    }
  }

  // Clipboard text goes over stdin, never argv (other users can read argv).
  function copyText(text) { clipboard.copy(text) }

  ClipboardWriter {
    id: clipboard
    onFailed: function(message) { backend.log("error", "clipboard", message, null) }
  }

  AppFocuser {
    id: appFocuser
    onLaunchRequested: function(candidate) { backend.launchApp(candidate) }
  }


  Process {
    id: mkdirs
    // Create only Foamy-owned directories and repair permissions on its stores.
    command: Paths.setupArgv(backend.paths, [Schema.documents.settings.file, Schema.documents.frecency.file, Schema.documents.calculator.file]
      .map(function(file) { return backend.paths.db + "/" + file }))
    onExited: function(exitCode) {
      if (exitCode !== 0) backend.log("error", "paths", "could not create data directories", { exitCode: exitCode })
      backend.directoriesReady = true
    }
  }

  ScopeSource {
    id: scopeSource
    directory: backend.directoriesReady ? backend.paths.scopes : ""
    pluginDir: backend.pluginDir
    builtins: backend.builtinScopes
    onScopesChanged: rebuildTimer.restart()
    onRevisionChanged: backend.candidatesRevision++
    onMessage: function(level, text, metadata) { backend.log(level, "scopes", text, metadata) }
  }

  // State of the scope on screen, for its empty and loading text.
  function scopeState(scopeId) {
    var scope = scopeSource.scope(scopeId)
    return {
      loaded: Scopes.isQuery(scope) || !!scopeSource.items[scopeId],
      loading: scopeSource.loading,
      failure: scopeSource.failures[scopeId] || "",
      emptyText: scope ? scope.emptyText : "",
      placeholder: scope ? scope.placeholder : "",
      keyword: scope ? scope.keyword : ""
    }
  }

  OmarchyMenuSource {
    id: menuSource
    onRevisionChanged: rebuildTimer.restart()
    onMessage: function(level, text, metadata) { backend.log(level, "omarchy-menu", text, metadata) }
  }

  JsonStore {
    id: settingsStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.settings.file
    migrations: Schema.documents.settings.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  JsonStore {
    id: frecencyStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.frecency.file
    migrations: Schema.documents.frecency.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  JsonStore {
    id: calculatorStore
    ready: backend.directoriesReady
    path: backend.paths.db + "/" + Schema.documents.calculator.file
    migrations: Schema.documents.calculator.migrations
    onMessage: function(level, text, metadata) { backend.log(level, "store", text, metadata) }
  }

  CalculatorData {
    id: calculatorData
    cacheDir: backend.directoriesReady ? backend.paths.cache : ""
    ratesEnabled: backend.settings.currencyRates
    onMessage: function(level, text, metadata) { backend.log(level, "calculator", text, metadata) }
  }

  readonly property int dataRevision: candidatesRevision + (settingsStore.loaded ? 1 : 0) + (frecencyStore.loaded ? 1 : 0)
  property int storeRevision: 0
  Connections { target: settingsStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: frecencyStore; function onChanged() { backend.storeRevision++ } }
  Connections { target: calculatorStore; function onChanged() { backend.storeRevision++ } }

}
