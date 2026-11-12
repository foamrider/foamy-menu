import QtQuick
import Quickshell.Io
import "../core/FleaSearch.js" as FleaSearch
import "../kit/FoamyNative.js" as FoamyNative

Item {
  id: service
  property var entries: []
  property var ids: []
  // The bundled helper is bin/<arch>/foamy-menu-search; without one for this
  // CPU (or after any failure) the built-in matcher takes over.
  property string pluginDir: FoamyNative.localPath(Qt.resolvedUrl(".."))
  property bool disabled: false
  property bool loaded: false
  property int serial: 0
  property int loadId: 0
  property var pending: null
  signal failed(string message)

  function cancel() {
    service.pending = null
    timeout.stop()
  }

  function invalidate() {
    var request = service.pending
    service.cancel()
    service.loaded = false
    service.loadId = 0
    if (helper.running)
      service.load()
    if (request)
      request.callback(null)
  }

  function search(query, sensitivity, callback) {
    service.cancel()
    if (service.disabled || query.length > FleaSearch.MAX_QUERY_LENGTH) {
      callback(null)
      return
    }
    service.pending = {
      id: ++service.serial,
      query: query,
      sensitivity: sensitivity,
      callback: callback
    }
    timeout.restart()
    if (!helper.running)
      helper.running = true
    else if (service.loaded)
      service.send()
  }

  function load() {
    service.loadId = ++service.serial
    helper.write(JSON.stringify({
      id: service.loadId,
      entries: service.entries
    }) + "\n")
  }

  function send() {
    var request = service.pending
    if (request)
      helper.write(JSON.stringify({
        id: request.id,
        query: request.query,
        sensitivity: request.sensitivity
      }) + "\n")
  }

  function fail(message) {
    var request = service.pending
    service.cancel()
    service.disabled = true
    service.loaded = false
    helper.running = false
    service.failed(message)
    if (request)
      request.callback(null)
  }

  function exited(exitCode) {
    if (service.disabled)
      return
    service.fail(FoamyNative.unavailable(exitCode) ? "Search helper isn't available for this CPU; using the built-in matcher" : "Search helper exited; using the built-in matcher")
  }

  function receive(line) {
    try {
      var data = FleaSearch.reply(line)
      var request = service.pending
      if (data.id !== service.loadId && (!request || data.id !== request.id))
        return
      if (data.error)
        throw new Error(String(data.error))
      if (data.id === service.loadId) {
        if (data.loaded !== service.entries.length)
          throw new Error("Search helper loaded the wrong entry count")
        service.loaded = true
        service.send()
        return
      }
      if (!request || data.id !== request.id)
        return
      var matches = FleaSearch.hits(data, service.ids)
      service.cancel()
      request.callback(matches)
    } catch (error) {
      service.fail(String(error))
    }
  }

  onEntriesChanged: service.invalidate()
  Component.onDestruction: {
    service.cancel()
    helper.running = false
  }

  Timer {
    id: timeout
    interval: 1000
    onTriggered: service.fail("Search helper timed out; using the built-in matcher")
  }

  Process {
    id: helper
    // FoamyNative's bash exec turns a missing binary or an unsupported CPU
    // into a normal exit 127 (126: not executable) instead of no exit at all.
    command: FoamyNative.command(service.pluginDir, "foamy-menu-search", [])
    stdinEnabled: true
    stdout: SplitParser {
      onRead: function (line) {
        service.receive(line)
      }
    }
    onStarted: service.load()
    onExited: function (exitCode, exitStatus) {
      service.exited(exitCode)
    }
  }
}
