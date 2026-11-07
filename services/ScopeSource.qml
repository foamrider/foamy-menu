import QtQuick
import Qt.labs.folderlistmodel
import Quickshell
import Quickshell.Io
import "../core/Scopes.js" as Scopes
import "../kit/FoamyNative.js" as FoamyNative

// The scopes the launcher offers: built-ins merged with the JSON files in
// ~/.config/foamy-menu/scopes/, watched so an edit applies without a restart.
// A scope's items load when it is entered (the last list stays on screen
// while it refreshes). Commands run as argv, never through a shell. A query
// scope that asks for suggestions fetches them while typing, one request at a
// time; nothing is sent for scopes that leave "suggest" off.
Item {
  id: source

  property string directory: ""
  property string pluginDir: ""
  // Scopes.BUILTINS with the shell.json settings applied (Settings.applyToScopes).
  property var builtins: Scopes.BUILTINS
  onBuiltinsChanged: rebuildTimer.restart()

  // Enabled scopes, in order: built-ins first, then user files by name.
  property var scopes: []
  property var problems: []
  // Ids of every query scope, enabled or not (Scopes.merge queryIds).
  property var queryScopeIds: []
  // scopeId -> [{ title, value, subtitle }]
  property var items: ({})
  // scopeId -> a short failure message from its last load
  property var failures: ({})
  // scopeId -> { query, items: [strings] }: the engine's last suggestions.
  property var suggestions: ({})
  property var pendingSuggestion: null
  property var suggestionRequest: null
  property int revision: 0
  readonly property bool loading: proc.running || proc.scopeId !== "" || queue.length > 0
  property var queue: []

  signal message(string level, string text, var metadata)

  function scope(id) {
    for (var i = 0; i < source.scopes.length; i++) if (source.scopes[i].id === id) return source.scopes[i]
    return null
  }

  function rebuild() {
    var files = []
    for (var i = 0; i < files_.count; i++) {
      var view = files_.objectAt(i)
      if (!view || !view.loadedOnce) continue
      if (view.failed) { files.push({ name: view.fileName, errors: ["could not be read"] }); continue }
      var parsed = Scopes.parseFile(view.fileName, view.text())
      files.push(parsed.definition ? { name: view.fileName, definition: parsed.definition } : { name: view.fileName, errors: parsed.errors })
    }
    var merged = Scopes.merge(source.builtins, files)
    var reported = JSON.stringify(merged.errors)
    if (reported !== JSON.stringify(source.problems)) {
      for (var p = 0; p < merged.errors.length; p++) {
        var problem = merged.errors[p]
        source.message("warning", "ignoring scope " + (problem.id || problem.file) + " (" + problem.file + "): " + problem.errors.join("; "), null)
      }
    }
    source.problems = merged.errors
    source.queryScopeIds = merged.queryIds
    // Items of a scope whose definition changed load again on next entry.
    var kept = ({})
    var before = JSON.stringify(source.scopes)
    for (var s = 0; s < merged.scopes.length; s++) {
      var id = merged.scopes[s].id
      var old = source.scope(id)
      if (old && JSON.stringify(old) === JSON.stringify(merged.scopes[s]) && source.items[id]) kept[id] = source.items[id]
    }
    if (JSON.stringify(merged.scopes) !== before) {
      source.scopes = merged.scopes
      source.items = kept
      source.revision++
    }
  }

  Timer {
    id: rebuildTimer
    interval: 50
    onTriggered: source.rebuild()
  }

  // Loads (or refreshes) a scope's items. A list scope is immediate.
  function refresh(id) {
    var scope = source.scope(id)
    if (!scope || scope.source.type === "query") return
    if (scope.source.type === "list") {
      source.setItems(id, scope.source.items.slice(0, Scopes.MAX_ITEMS), "")
      return
    }
    if (proc.scopeId === id || source.queue.indexOf(id) >= 0) return
    source.queue = source.queue.concat([id])
    source.next()
  }

  function setItems(id, list, failure) {
    var nextItems = Object.assign({}, source.items)
    if (list) nextItems[id] = list
    source.items = nextItems
    var nextFailures = Object.assign({}, source.failures)
    if (failure) nextFailures[id] = failure
    else delete nextFailures[id]
    source.failures = nextFailures
    source.revision++
  }

  function next() {
    if (proc.running || proc.scopeId !== "" || source.queue.length === 0) return
    var id = source.queue[0]
    source.queue = source.queue.slice(1)
    var scope = source.scope(id)
    if (!scope) { source.next(); return }
    proc.scopeId = id
    proc.timedOut = false
    proc.command = Scopes.fill(scope.source.command, "", source.pluginDir)
    timeout.interval = scope.source.timeout
    proc.running = true
    timeout.restart()
  }

  // Suggestions for the typed text, after a short pause in typing.
  function suggest(id, query) {
    source.pendingSuggestion = { id: id, query: query }
    suggestDelay.restart()
  }

  function storeSuggestions(id, query, items) {
    var next = Object.assign({}, source.suggestions)
    next[id] = { query: query, items: items }
    source.suggestions = next
    source.revision++
  }

  function fetchSuggestions() {
    var job = source.pendingSuggestion
    source.pendingSuggestion = null
    var scope = job ? source.scope(job.id) : null
    if (!scope || !scope.suggest) return
    if (source.suggestionRequest) {
      // Cleared first: abort() can report DONE to the old request's handler.
      var previous = source.suggestionRequest
      source.suggestionRequest = null
      previous.abort()
    }
    var xhr = new XMLHttpRequest()
    source.suggestionRequest = xhr
    xhr.onreadystatechange = function() {
      // source is null once the plugin reloads with this request in flight.
      if (!source || xhr.readyState !== XMLHttpRequest.DONE || source.suggestionRequest !== xhr) return
      source.suggestionRequest = null
      suggestTimeout.stop()
      source.storeSuggestions(job.id, job.query, xhr.status === 200 ? Scopes.parseSuggestions(xhr.responseText) : [])
    }
    xhr.open("GET", Scopes.fillText(scope.suggestUrl, job.query))
    xhr.send()
    suggestTimeout.job = job
    suggestTimeout.restart()
  }

  Timer {
    id: suggestDelay
    interval: 180
    onTriggered: source.fetchSuggestions()
  }

  Timer {
    id: suggestTimeout
    property var job: null
    interval: 3000
    onTriggered: {
      if (!source.suggestionRequest) return
      var request = source.suggestionRequest
      source.suggestionRequest = null
      request.abort()
      if (job) source.storeSuggestions(job.id, job.query, [])
    }
  }

  Timer {
    id: timeout
    onTriggered: if (proc.running) { proc.timedOut = true; proc.signal(15) }
  }

  Process {
    id: proc
    property string scopeId: ""
    property bool timedOut: false
    stdout: StdioCollector { id: out }
    stderr: StdioCollector { id: err }
    onExited: function(exitCode) {
      timeout.stop()
      var id = proc.scopeId
      var failure = ""
      if (proc.timedOut) failure = "timed out"
      // The bundled helper (the SSH scope's) has no binary for this CPU.
      else if (FoamyNative.unavailable(exitCode) && Scopes.isNativeCommand(proc.command)) failure = FoamyNative.UNAVAILABLE_TEXT
      else if (exitCode !== 0) failure = (String(err.text || "").split("\n").filter(function(l) { return l.trim() })[0] || ("exited with code " + exitCode)).slice(0, 200)
      if (failure) source.message("warning", "scope " + id + ": " + failure, { command: proc.command })
      // A failed refresh keeps the items it had.
      source.setItems(id, failure ? null : Scopes.parseOutput(out.text), failure)
      proc.scopeId = ""
      Qt.callLater(source.next)
    }
  }

  FolderListModel {
    id: folder
    folder: source.directory ? "file://" + source.directory : ""
    nameFilters: ["*.json"]
    showDirs: false
    showHidden: false
    showDotAndDotDot: false
    sortField: FolderListModel.Name
  }

  Instantiator {
    id: files_
    model: folder
    onObjectAdded: rebuildTimer.restart()
    onObjectRemoved: rebuildTimer.restart()

    delegate: FileView {
      required property string fileName
      required property string filePath
      property bool loadedOnce: false
      property bool failed: false
      path: filePath
      watchChanges: true
      printErrors: false
      onFileChanged: reload()
      onLoaded: { loadedOnce = true; failed = false; rebuildTimer.restart() }
      onLoadFailed: { loadedOnce = true; failed = true; rebuildTimer.restart() }
    }
  }

  Component.onCompleted: source.rebuild()
}
