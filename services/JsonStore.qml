import QtQuick
import Quickshell.Io
import "../core/Migrate.js" as Migrate

Item {
  id: store

  required property string path
  required property var migrations
  property bool ready: false
  property var now: function () {
    return Date.now()
  }

  property var doc: null
  property bool loaded: false
  property bool readOnly: false
  property string lastError: ""

  signal changed
  signal message(string level, string text, var metadata)

  property string _lastWritten: ""

  function update(mutator) {
    if (!store.loaded || store.readOnly)
      return false
    var next = JSON.parse(JSON.stringify(store.doc))
    var result = mutator(next)
    store.doc = result === undefined ? next : result
    saveTimer.restart()
    store.changed()
    return true
  }

  function flush() {
    if (!saveTimer.running)
      return
    saveTimer.stop()
    store.write()
  }

  function write() {
    if (!store.loaded || store.readOnly)
      return
    var text = Migrate.serialize(store.doc)
    if (text === store._lastWritten)
      return
    store._lastWritten = text
    file.setText(text)
  }

  // A file the store cannot use stays as it is and the store goes
  // read-only. A store that has no document yet gets the one a new file
  // would have (held in memory only), so its users can go on. The same error
  // is reported once: a file without read permission cannot be watched, so
  // it is read again whenever another file in its directory changes.
  function fail(error, text) {
    store.readOnly = true
    if (error !== store.lastError)
      store.message("error", text || error, null)
    store.lastError = error
    if (store.loaded)
      return
    store.doc = Migrate.migrate(null, store.migrations, store.now()).doc
    store.loaded = true
    store.changed()
  }

  // The parts a new document has as an object or a list, in a migrated
  // document: a missing one is added as a new document has it (there is no
  // data to lose; the file gets it with the next change), and one of another
  // type makes the document unusable. Returns why, or "".
  // Migrate keeps schemaHistory itself, and nothing here reads it.
  function fillParts(doc) {
    var kind = function (value) {
      return Array.isArray(value) ? "list" : value === null ? "null" : typeof value
    }
    var empty = Migrate.migrate(null, store.migrations, store.now()).doc
    var added = []
    for (const key in empty) {
      const want = kind(empty[key])
      if (key === "schemaHistory" || (want !== "object" && want !== "list"))
        continue
      if (doc[key] === undefined) {
        doc[key] = empty[key]
        added.push(key)
      } else if (kind(doc[key]) !== want) {
        return key + " is not " + (want === "list" ? "a list" : "an object")
      }
    }
    if (added.length > 0)
      store.message("warning", store.path + " has no " + added.join(", ") + "; using what a new file has", null)
    return ""
  }

  function ingest(text) {
    if (store.loaded && !store.readOnly && text === store._lastWritten)
      return
    var parsed = Migrate.parse(text)
    if (parsed.error)
      return store.fail("unreadable " + store.path + ": " + parsed.error, "unreadable " + store.path + ": " + parsed.error + " (left untouched; fix or remove it)")
    // An empty or missing file while the store holds what it read from it is
    // another program saving it in place (empty, then write) or removing it,
    // not a new file: writing a new document now would replace the data and
    // the save in progress. The data stays in memory and is written with the
    // next change.
    if (!parsed.doc && store.loaded && !store.lastError) {
      store._lastWritten = ""
      store.message("warning", store.path + " is empty or gone; keeping its data until the next change", null)
      return
    }

    var result
    try {
      result = Migrate.migrate(parsed.doc, store.migrations, store.now())
    } catch (e) {
      return store.fail("migration failed for " + store.path + ": " + e)
    }
    if (result.error)
      return store.fail(result.error, store.path + ": " + result.error)
    var shape = store.fillParts(result.doc)
    if (shape)
      return store.fail("unusable " + store.path + ": " + shape, "unusable " + store.path + ": " + shape + " (left untouched; fix or remove it)")

    store.readOnly = result.readOnly
    store.lastError = ""
    if (result.readOnly)
      store.message("warning", store.path + " has schemaVersion " + result.from + ", newer than this build; not writing it", null)
    if (result.applied.length > 0)
      store.message("info", "migrated " + store.path, {
        from: result.from,
        to: result.to,
        applied: result.applied
      })

    store._lastWritten = String(text || "")
    store.doc = result.doc
    store.loaded = true
    if (result.changed)
      store.write()
    store.changed()
  }

  Component.onDestruction: store.flush()

  Timer {
    id: saveTimer
    interval: 250
    onTriggered: store.write()
  }

  FileView {
    id: file
    path: store.ready ? store.path : ""
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: store.ingest(text())
    onFileChanged: reload()
    onLoadFailed: function (error) {
      if (error === FileViewError.FileNotFound)
        store.ingest("")
      else
        store.fail("cannot read " + store.path + ": " + FileViewError.toString(error))
    }
    onSaveFailed: function (error) {
      store.message("error", "cannot write " + store.path + ": " + FileViewError.toString(error), null)
    }
  }
}
