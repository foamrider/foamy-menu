import QtQuick
import Qt.labs.folderlistmodel
import Quickshell
import Quickshell.Io
import "../core/Scopes.js" as Scopes
import "../kit/FoamyNative.js" as FoamyNative

// The scopes the launcher offers: built-ins merged with the JSON files in
// ~/.config/foamy-menu/scopes/, watched so an edit applies without a restart.
// A scope's items load when it is entered (the last list stays on screen
// while it refreshes). Commands run as argv, one at a time, each under
// `timeout` (Scopes.bounded) so a hung one and its children end at the
// scope's deadline and the queue moves on, and behind a fixed bash wrapper
// (Scopes.capped) that cuts stdout at MAX_OUTPUT bytes; the argv stays the
// wrapper's arguments, never shell text. A query
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
      // Items first: a scopesChanged handler may load a list source at once
      // (Backend.refreshRootScopes), and that must not be reset afterwards.
      source.items = kept
      source.scopes = merged.scopes
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
    // A run for this definition, queued or running, answers this request too;
    // one for a definition edited since then can't, so the new one queues.
    if (source.queue.indexOf(id) >= 0 || (proc.scopeId === id && proc.definition === JSON.stringify(scope))) return
    source.queue = source.queue.concat([id])
    source.next()
  }

  function setItems(id, list, failure) {
    // The same list again keeps the old one, so nothing rebuilds for it.
    if (list && !(source.items[id] && JSON.stringify(source.items[id]) === JSON.stringify(list))) {
      var nextItems = Object.assign({}, source.items)
      nextItems[id] = list
      source.items = nextItems
    }
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
    proc.definition = JSON.stringify(scope)
    proc.scopeCommand = Scopes.fill(scope.source.command, "", source.pluginDir)
    proc.timeoutMs = scope.source.timeout
    proc.lines = []
    proc.stderrHead = ""
    proc.startedAt = Date.now()
    proc.command = Scopes.bounded(Scopes.capped(proc.scopeCommand), scope.source.timeout)
    watchdog.interval = scope.source.timeout + Scopes.WATCHDOG_GRACE_MS
    proc.running = true
    watchdog.restart()
  }

  // The one way a scope load ends: exited, couldn't start, or given up on by
  // the watchdog. Later calls for the same run (running -> false after
  // exited(), the exit of a run the watchdog gave up on) find no scopeId.
  // A failed refresh keeps the items it had. A run whose scope was edited or
  // removed while it ran is stale: its result is dropped (refresh() queued
  // the new definition's run).
  function finish(failure) {
    if (proc.scopeId === "") return
    watchdog.stop()
    var id = proc.scopeId
    var current = source.scope(id)
    if (current && JSON.stringify(current) === proc.definition) {
      if (failure) source.message("warning", "scope " + id + ": " + failure, { command: proc.scopeCommand })
      source.setItems(id, failure ? null : Scopes.parseOutput(proc.lines.join("\n")), failure)
    }
    proc.scopeId = ""
    proc.lines = []
    Qt.callLater(source.next)
  }

  // Output arrives a line at a time (whole lines, so no character is split;
  // Scopes.capped bounds what a line can hold).
  function keepLine(line) {
    if (proc.scopeId !== "") proc.lines.push(line)
  }

  function keepStderr(data) {
    if (proc.stderrHead.length < Scopes.MAX_STDERR) proc.stderrHead += String(data).slice(0, Scopes.MAX_STDERR - proc.stderrHead.length)
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
    // Replaces a request still in flight; its reply is dropped.
    suggestFetch.get(Scopes.fillText(scope.suggestUrl, job.query), job)
  }

  Timer {
    id: suggestDelay
    interval: 180
    onTriggered: source.fetchSuggestions()
  }

  // A failed, slow or oversized reply leaves no suggestions for that text.
  BoundedFetch {
    id: suggestFetch
    timeoutSeconds: 3
    onFinished: function(job, text, failure) {
      source.storeSuggestions(job.id, job.query, failure ? [] : Scopes.parseSuggestions(text))
    }
  }

  // Backstop: `timeout` normally ends the command at its deadline. If no exit
  // came by WATCHDOG_GRACE_MS later, SIGKILL what's left and move on; if the
  // command isn't running at all, its start was lost.
  Timer {
    id: watchdog
    onTriggered: {
      if (!proc.running) { source.finish("couldn't start"); return }
      proc.signal(9)
      source.finish("timed out")
    }
  }

  Process {
    id: proc
    property string scopeId: ""
    // The scope definition this run is for (JSON), to tell a stale result.
    property string definition: ""
    // The scope's own command (proc.command is it under timeout).
    property var scopeCommand: []
    property int timeoutMs: 0
    property double startedAt: 0
    property var lines: []
    property string stderrHead: ""
    stdout: SplitParser { onRead: function(line) { source.keepLine(line) } }
    // Chunks as they arrive (no split), so at most MAX_STDERR is ever kept.
    stderr: SplitParser {
      splitMarker: ""
      onRead: function(data) { source.keepStderr(data) }
    }
    onExited: function(exitCode, exitStatus) {
      var failure = ""
      if (Scopes.wasCapped(exitCode, exitStatus)) {
        // Cut at MAX_OUTPUT bytes, most likely inside a line: the whole lines
        // before it are the list.
        proc.lines.pop()
        source.message("warning", "scope " + proc.scopeId + ": output is over " + Scopes.MAX_OUTPUT + " bytes; keeping the lines before that", { command: proc.scopeCommand })
      }
      else if (Scopes.timedOut(exitCode, exitStatus, Date.now() - proc.startedAt, proc.timeoutMs)) failure = "timed out"
      // The bundled helper (the SSH scope's) has no binary for this CPU.
      else if (FoamyNative.unavailable(exitCode) && Scopes.isNativeCommand(proc.scopeCommand)) failure = FoamyNative.UNAVAILABLE_TEXT
      else if (exitCode !== 0) failure = Scopes.exitFailure(exitCode, proc.stderrHead)
      source.finish(failure)
    }
    // After exited() this finds no scopeId. Without exited() before it the
    // command never started (Quickshell then emits only running -> false).
    onRunningChanged: {
      if (running) return
      source.finish("couldn't start")
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
