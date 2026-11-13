import QtQuick
import Quickshell.Io
import "../core/FleaSearch.js" as FleaSearch
import "../kit/FoamyNative.js" as FoamyNative

Item {
  id: service
  // The helper's lists by catalog name (see search/src/protocol.rs): each is
  // { line, count, ids, loadId, loaded }, where line is the JSON entries
  // array as sent. Backend sets "root" (the root candidates, which submenus
  // and the Apps grid search too) and "view" (the open scope's items or the
  // settings rows).
  property var catalogs: ({})
  // The bundled helper is bin/<arch>/foamy-menu-search; without one for this
  // CPU (or after any failure) the built-in matcher takes over in every view.
  property string pluginDir: FoamyNative.localPath(Qt.resolvedUrl(".."))
  property bool disabled: false
  property int serial: 0
  property var pending: null
  signal failed(string message)

  function cancel() {
    service.pending = null
    timeout.stop()
  }

  // Sets a catalog's list (entries as FleaSearch.entries makes them, ids in
  // the same order). The helper loads it again only when the entries
  // changed. A search pending on this catalog gets a new id, so a reply the
  // helper computed on the old list (its indexes) can't match, and it is
  // sent again once the new list is loaded.
  function setCatalog(name, entries, ids) {
    var line = JSON.stringify(entries)
    var current = service.catalogs[name]
    if (current && current.line === line) {
      // Same entries at the same indexes: a reply maps through the new ids.
      current.ids = ids
      return
    }
    service.catalogs[name] = {
      line: line,
      count: entries.length,
      ids: ids,
      loadId: 0,
      loaded: false
    }
    var request = service.pending
    if (request && request.catalog === name)
      request.id = ++service.serial
    if (helper.running)
      service.load(name)
  }

  function search(name, query, sensitivity, callback) {
    service.cancel()
    var catalog = service.catalogs[name]
    if (service.disabled || !catalog || query.length > FleaSearch.MAX_QUERY_LENGTH) {
      callback(null)
      return
    }
    service.pending = {
      id: ++service.serial,
      catalog: name,
      query: query,
      sensitivity: sensitivity,
      callback: callback
    }
    timeout.restart()
    if (!helper.running)
      helper.running = true
    else if (catalog.loaded)
      service.send()
  }

  function load(name) {
    var catalog = service.catalogs[name]
    catalog.loaded = false
    catalog.loadId = ++service.serial
    // The entries are already JSON; only the envelope is built here.
    helper.write("{\"id\":" + catalog.loadId + ",\"catalog\":" + JSON.stringify(name) + ",\"entries\":" + catalog.line + "}\n")
  }

  function loadAll() {
    for (const name in service.catalogs)
      service.load(name)
  }

  function send() {
    var request = service.pending
    if (request)
      helper.write(JSON.stringify({
        id: request.id,
        catalog: request.catalog,
        query: request.query,
        sensitivity: request.sensitivity
      }) + "\n")
  }

  function fail(message) {
    var request = service.pending
    service.cancel()
    service.disabled = true
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

  // The catalog whose current load has this id, or "".
  function loading(id) {
    for (const name in service.catalogs)
      if (service.catalogs[name].loadId === id)
        return name
    return ""
  }

  function receive(line) {
    try {
      const data = FleaSearch.reply(line)
      const request = service.pending
      const name = service.loading(data.id)
      // A reply to a replaced load, or to a cancelled or re-sent search.
      if (!name && (!request || data.id !== request.id))
        return
      if (data.error)
        throw new Error(String(data.error))
      if (name) {
        const catalog = service.catalogs[name]
        if (data.loaded !== catalog.count)
          throw new Error("Search helper loaded the wrong entry count")
        catalog.loaded = true
        if (request && request.catalog === name)
          service.send()
        return
      }
      const matches = FleaSearch.hits(data, service.catalogs[request.catalog].ids)
      service.cancel()
      request.callback(matches)
    } catch (error) {
      service.fail(String(error))
    }
  }

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
    onStarted: service.loadAll()
    onExited: function (exitCode, exitStatus) {
      service.exited(exitCode)
    }
  }
}
